// ১. ফায়ারবেসের সার্ভিস ওয়ার্কার লাইব্রেরি ইমপোর্ট করা হচ্ছে
importScripts('https://www.gstatic.com/firebasejs/9.22.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.1/firebase-messaging-compat.js');

// ২. আপনার Seba ডাটাবেসের ফায়ারবেস কনফিগারেশন
const firebaseConfig = {
  apiKey: "AIzaSyAppXDx9dQYxJZgOpvkmOz_r23-1c6t_OM",
  authDomain: "dital-cd21f.firebaseapp.com",
  projectId: "dital-cd21f",
  storageBucket: "dital-cd21f.firebasestorage.app",
  messagingSenderId: "266147223222",
  appId: "1:266147223222:web:8676b327a348d1f0993817",
  databaseURL: "https://dital-cd21f-default-rtdb.firebaseio.com/"
};

// ৩. ফায়ারবেস ইনিশিয়ালাইজ করা
firebase.initializeApp(firebaseConfig);

// ৪. মেসেজিং সার্ভিস চালু করা
const messaging = firebase.messaging();

// ৫. ব্যাকগ্রাউন্ড মেসেজ রিসিভার (অ্যাপ বন্ধ থাকলে এটি কাজ করবে)
messaging.onBackgroundMessage(function(payload) {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);

  // নোটিফিকেশনের টাইটেল এবং বডি সেট করা
  const notificationTitle = payload.notification.title || 'GMDS Update!';
  const notificationOptions = {
    body: payload.notification.body || 'You have a new message from GMDS.',
    icon: 'logo.png', // আপনার অ্যাপের লোগোর লিংক (রুট ফোল্ডারে logo.png থাকতে হবে)
    badge: 'logo.png',
    vibrate: [200, 100, 200, 100, 200, 100, 200], // ভাইব্রেশন প্যাটার্ন
    data: payload.data
  };

  // ইউজারের মোবাইলের নোটিফিকেশন প্যানেলে মেসেজ শো করানো
  self.registration.showNotification(notificationTitle, notificationOptions);
});
