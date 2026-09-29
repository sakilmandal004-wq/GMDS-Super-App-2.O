// rider-routes.js — GMDS Rider API
// server.js এ যুক্ত: require('./rider-routes')(app, dbs)
// Render Environment: RIDER_SECRET (৩২+ র‍্যান্ডম অক্ষর), ADMIN_KEY (আগেরটাই), RIDER_SHARE (ঐচ্ছিক, ডিফল্ট 0.8 = ডেলিভারি চার্জের ৮০% রাইডারের)
const crypto = require('crypto');

module.exports = function (app, dbs) {
  const core = dbs.core;
  // ⚠️ admin-routes.js এর SOURCES এর সাথে একই path রাখুন (রাইডারের কাজ শুধু food ও delivery)
  const SRC = [
    { svc: 'food', db: dbs.core, path: 'all_orders' },
    { svc: 'delivery', db: dbs.medicine, path: 'delivery_orders' },
  ];
  const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')); return isNaN(n) ? 0 : n; };
  const ts = (o) => +o.rawTimestamp || +o.createdAt || +((String(o.orderId || '').match(/\d{12,}/) || [])[0]) || 0;
  const ist = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const cx = (o) => /cancel/i.test(o.status || '');
  const err = (res, code, message) => res.status(code).json({ status: 'error', message });
  const km = (a, b, c, d) => { if (!a || !b || !c || !d) return 0; const R = 6371, r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r;
    const h = Math.sin(x / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)) * 1.4; };

  // ---------- টোকেন ও পিন ----------
  const SECRET = () => process.env.RIDER_SECRET || '';
  const mac = (p) => crypto.createHmac('sha256', SECRET()).update(p).digest('base64url');
  const sign = (phone) => { const p = phone + '.' + (Date.now() + 12 * 3600e3); return p + '.' + mac(p); };
  function verify(t) {
    const [phone, exp, sig] = String(t || '').split('.');
    if (!sig || !SECRET()) return null;
    const a = Buffer.from(sig), b = Buffer.from(mac(phone + '.' + exp));
    return a.length === b.length && crypto.timingSafeEqual(a, b) && Date.now() < +exp ? phone : null;
  }
  const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
  const tries = new Map();

  async function auth(req, res) {
    const phone = verify(req.body && req.body.token);
    if (!phone) { err(res, 401, 'আবার লগইন করুন'); return null; }
    const r = (await core.ref('riders/' + phone).once('value')).val();
    if (!r || r.active === false) { err(res, 403, 'অ্যাকাউন্ট বন্ধ আছে'); return null; }
    return { phone, r };
  }

  // ---------- অ্যাডমিন: রাইডার যোগ/বন্ধ ----------
  app.post('/api/admin/rider/add', async (req, res) => {
    const a = Buffer.from(String(req.headers['x-admin-key'] || '')), b = Buffer.from(process.env.ADMIN_KEY || '');
    if (!b.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return err(res, 401, 'Unauthorized');
    const { phone, name, pin, vehicle, active } = req.body || {};
    if (!/^\d{10}$/.test(phone || '')) return err(res, 400, 'ফোন ১০ ডিজিট হতে হবে');
    const ref = core.ref('riders/' + phone), old = (await ref.once('value')).val() || {};
    const upd = { name: name || old.name || 'Rider', vehicle: vehicle || old.vehicle || 'Bike', active: active !== false };
    if (pin) { if (!/^\d{4,6}$/.test(String(pin))) return err(res, 400, 'PIN ৪-৬ ডিজিট'); upd.salt = crypto.randomBytes(16).toString('hex'); upd.pinHash = hashPin(pin, upd.salt); }
    else if (!old.pinHash) return err(res, 400, 'নতুন রাইডারের PIN দিন');
    await ref.update(upd); res.json({ status: 'success' });
  });

  // অ্যাডমিন: রাইডার লিস্ট (PIN/hash কখনো পাঠানো হয় না)
  app.get('/api/admin/riders', async (req, res) => {
    const a = Buffer.from(String(req.headers['x-admin-key'] || '')), b = Buffer.from(process.env.ADMIN_KEY || '');
    if (!b.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return err(res, 401, 'Unauthorized');
    const all = (await core.ref('riders').once('value')).val() || {};
    res.json({ status: 'success', riders: Object.entries(all).map(([phone, r]) => ({ phone, name: r.name, vehicle: r.vehicle, active: r.active !== false, online: !!r.online, lastSeen: r.lastSeen || 0 })) });
  });

  app.post('/api/rider/login', async (req, res) => {
    const { phone, pin } = req.body || {}, k = req.ip + phone, t = tries.get(k) || { n: 0, at: Date.now() };
    if (t.n >= 5 && Date.now() - t.at < 10 * 60000) return err(res, 429, 'অনেকবার ভুল। ১০ মিনিট পর চেষ্টা করুন');
    const r = /^\d{10}$/.test(phone || '') ? (await core.ref('riders/' + phone).once('value')).val() : null;
    const ok = r && r.active !== false && r.pinHash && (() => { const x = Buffer.from(hashPin(pin || '', r.salt)), y = Buffer.from(r.pinHash); return x.length === y.length && crypto.timingSafeEqual(x, y); })();
    if (!ok) { tries.set(k, { n: t.n + 1, at: t.n ? t.at : Date.now() }); return err(res, 401, 'ফোন বা PIN ভুল'); }
    tries.delete(k); res.json({ status: 'success', token: sign(phone), name: r.name, vehicle: r.vehicle });
  });

  // ---------- ডেটা লোড (৩ সেকেন্ড ক্যাশ) ----------
  let rc = { t: 0, list: [] }, hc = { t: 0, v: {} };
  async function recent() {
    if (Date.now() - rc.t < 3000) return rc.list;
    const list = [];
    await Promise.all(SRC.map(async (s) => {
      const snap = await s.db.ref(s.path).orderByKey().limitToLast(150).once('value');
      snap.forEach((c) => { const o = c.val(); if (o && typeof o === 'object') list.push({ s, key: c.key, o }); });
    }));
    rc = { t: Date.now(), list }; return list;
  }
  async function hotels() {
    if (Date.now() - hc.t > 60000) hc = { t: Date.now(), v: (await core.ref('hotel_status').once('value')).val() || {} };
    return hc.v;
  }

  function job(s, o, H, mine) {
    const online = String(o.payMode).toUpperCase() === 'ONLINE';
    let pickups, drop, fee, collect, title, extra = {};
    if (s.svc === 'food') {
      const names = [...new Set((o.items || []).map((i) => i.hotel).filter(Boolean))];
      pickups = names.map((n) => { const h = H[n.replace(/[^A-Za-z0-9]/g, '')] || {}; return { name: n, lat: +h.lat || 0, lng: +h.lng || 0 }; });
      if (!pickups.length) pickups = [{ name: 'Restaurant', lat: 0, lng: 0 }];
      const m = String(o.gpsLocation || '').match(/(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
      drop = { address: o.address || '', lat: m ? +m[1] : 0, lng: m ? +m[2] : 0 };
      fee = num(o.deliveryFee); collect = online ? 0 : num(o.grandTotal); title = 'ফুড ডেলিভারি';
      extra = { itemCount: (o.items || []).reduce((n, i) => n + (+i.qty || 1), 0), receiver: o.remoteOrder ? o.receiverPhone : '' };
    } else {
      const d = o.details || {};
      pickups = [{ name: d.pickup || '', lat: +d.pickupLat || 0, lng: +d.pickupLng || 0 }];
      drop = { address: d.drop || '', lat: +d.dropLat || 0, lng: +d.dropLng || 0 };
      fee = num(o.price ?? d.totalFare); collect = online ? 0 : fee; title = d.type || 'Delivery/Ride';
      extra = { vehicle: d.vehicle || '', passengers: d.passengers || 0, item: d.itemName || '', size: d.size || '', receiver: d.receiverPhone || '' };
    }
    const j = { orderId: String(o.orderId), service: s.svc, title, pickups, drop, payout: Math.round(fee * parseFloat(process.env.RIDER_SHARE || '0.8')),
      collect, paidOnline: online, distance: +km(pickups[0].lat, pickups[0].lng, drop.lat, drop.lng).toFixed(1), createdAt: ts(o), riderStatus: o.riderStatus || o.status, ...extra };
    if (mine) j.phone = o.phone || ''; else delete j.receiver;
    return j;
  }

  app.post('/api/rider/feed', async (req, res) => {
    try {
      const me = await auth(req, res); if (!me) return;
      const [list, H, es] = await Promise.all([recent(), hotels(), core.ref('rider_earnings/' + me.phone).orderByKey().limitToLast(300).once('value')]);
      const online = !!me.r.online;
      const mine = list.filter((x) => x.o.riderPhone === me.phone && !cx(x.o) && x.o.status !== 'Delivered').map((x) => job(x.s, x.o, H, true));
      const available = online ? list.filter((x) => !x.o.riderPhone && !cx(x.o) && ['Pending', 'Confirmed'].includes(x.o.status || 'Pending')
        && Date.now() - ts(x.o) < 3 * 3600e3 && !(String(x.o.payMode).toUpperCase() === 'ONLINE' && !x.o.razorpayPaymentId)).map((x) => job(x.s, x.o, H, false)).sort((a, b) => b.createdAt - a.createdAt) : [];
      const rows = []; es.forEach((c) => { rows.push({ orderId: c.key, ...c.val() }); }); rows.sort((a, b) => b.at - a.at);
      const td = rows.filter((r) => ist(r.at) === ist(Date.now()));
      const stats = { todayCount: td.length, todayEarn: td.reduce((n, r) => n + r.amount, 0), totalCount: rows.length, totalEarn: rows.reduce((n, r) => n + r.amount, 0),
        codHeld: rows.filter((r) => !r.settled).reduce((n, r) => n + (r.cod || 0), 0), recent: rows.slice(0, 25) };
      res.json({ status: 'success', online, name: me.r.name, mine, available, stats });
    } catch (e) { console.error('rider/feed', e); err(res, 500, 'Server error'); }
  });

  app.post('/api/rider/online', async (req, res) => {
    const me = await auth(req, res); if (!me) return;
    await core.ref('riders/' + me.phone).update({ online: !!req.body.online, lastSeen: Date.now() }); res.json({ status: 'success' });
  });

  // ---------- অর্ডার খোঁজা ----------
  const memo = new Map();
  async function find(id) {
    id = String(id || ''); if (!/^[\w-]{6,60}$/.test(id)) return null;
    for (const s of SRC) {
      if (memo.has(id) && memo.get(id) !== s.svc) continue;
      let snap = await s.db.ref(s.path + '/' + id).once('value');
      if (!snap.exists()) for (const v of [id, Number(id)]) {
        if (isNaN(v)) continue;
        const q = await s.db.ref(s.path).orderByChild('orderId').equalTo(v).limitToFirst(1).once('value');
        if (q.exists()) { q.forEach((c) => { snap = c; }); break; }
      }
      if (snap.exists()) { memo.set(id, s.svc); return { s, ref: snap.ref, o: snap.val(), id }; }
    }
    return null;
  }
  const push = (f, upd) => Promise.all([f.ref.update(upd), f.s.db.ref('order_tracking/' + f.id).update(upd)]);

  app.post('/api/rider/accept', async (req, res) => {
    try {
      const me = await auth(req, res); if (!me) return;
      if (!me.r.online) return err(res, 400, 'আগে Online হন');
      const f = await find(req.body.orderId); if (!f) return err(res, 404, 'অর্ডার পাওয়া যায়নি');
      if (cx(f.o)) return err(res, 409, 'কাস্টমার অর্ডার ক্যানসেল করেছে');
      if (f.o.riderPhone) return err(res, 409, 'অন্য রাইডার নিয়ে নিয়েছে');
      const busy = (await recent()).filter((x) => x.o.riderPhone === me.phone && !cx(x.o) && x.o.status !== 'Delivered').length;
      if (busy >= 2) return err(res, 409, 'একসাথে সর্বোচ্চ ২টি অর্ডার নেওয়া যাবে');
      const tx = await f.ref.child('riderPhone').transaction((cur) => (cur ? undefined : me.phone));
      if (!tx.committed) return err(res, 409, 'অন্য রাইডার নিয়ে নিয়েছে');
      if (cx((await f.ref.once('value')).val() || {})) { await f.ref.child('riderPhone').remove(); return err(res, 409, 'কাস্টমার অর্ডার ক্যানসেল করেছে'); }
      await push(f, { riderName: me.r.name, riderPhone: me.phone, vehicle: me.r.vehicle || 'Bike', riderStatus: 'Accepted', status: 'Accepted', acceptedAt: Date.now(), estTime: 15 });
      rc.t = 0; res.json({ status: 'success' });
    } catch (e) { console.error('rider/accept', e); err(res, 500, 'Server error'); }
  });

  const NEXT = { Accepted: 'PickedUp', PickedUp: 'Delivered' };
  app.post('/api/rider/status', async (req, res) => {
    try {
      const me = await auth(req, res); if (!me) return;
      const f = await find(req.body.orderId); if (!f || f.o.riderPhone !== me.phone) return err(res, 403, 'এটি আপনার অর্ডার নয়');
      if (cx(f.o)) return err(res, 409, 'অর্ডার ক্যানসেল হয়েছে');
      const to = req.body.status;
      if (NEXT[f.o.riderStatus] !== to) return err(res, 400, 'ভুল ধাপ');
      await push(f, { riderStatus: to, status: to, [to === 'PickedUp' ? 'pickedUpAt' : 'deliveredAt']: Date.now() });
      if (to === 'Delivered') {
        const j = job(f.s, f.o, await hotels(), true);
        await core.ref(`rider_earnings/${me.phone}/${f.id}`).set({ amount: j.payout, cod: j.collect, at: Date.now(), svc: f.s.svc, settled: j.collect === 0 });
      }
      rc.t = 0; res.json({ status: 'success' });
    } catch (e) { console.error('rider/status', e); err(res, 500, 'Server error'); }
  });

  app.post('/api/rider/location', async (req, res) => {
    try {
      const me = await auth(req, res); if (!me) return;
      const lat = +req.body.lat, lng = +req.body.lng;
      if (!(lat > 5 && lat < 40 && lng > 65 && lng < 100)) return err(res, 400, 'Bad location');
      const f = await find(req.body.orderId); if (!f || f.o.riderPhone !== me.phone) return err(res, 403, 'এটি আপনার অর্ডার নয়');
      const j = job(f.s, f.o, await hotels(), true), t = f.o.riderStatus === 'PickedUp' ? j.drop : j.pickups[0];
      await f.s.db.ref('order_tracking/' + f.id).update({ riderLat: lat, riderLng: lng, estTime: Math.max(1, Math.round(km(lat, lng, t.lat, t.lng) * 3) + 2) });
      res.json({ status: 'success' });
    } catch (e) { err(res, 500, 'Server error'); }
  });
};
