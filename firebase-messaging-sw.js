// ফায়ারবেস লাইব্রেরি ইমপোর্ট
importScripts('https://www.gstatic.com/firebasejs/9.22.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.1/firebase-messaging-compat.js');

// আপনার Seba প্রোজেক্টের কনফিগ
const firebaseConfig = {
    apiKey: "AIzaSyAppXDx9dQYxJZgOpvkmOz_r23-1c6t_OM",
    authDomain: "dital-cd21f.firebaseapp.com",
    projectId: "dital-cd21f",
    storageBucket: "dital-cd21f.firebasestorage.app",
    messagingSenderId: "266147223222",
    appId: "1:266147223222:web:8676b327a348d1f0993817"
};

// ফায়ারবেস ইনিশিয়ালাইজ
firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// অ্যাপ বন্ধ থাকা অবস্থায় ব্যাকগ্রাউন্ডে মেসেজ রিসিভ করা
messaging.onBackgroundMessage(function(payload) {
    console.log('[firebase-messaging-sw.js] Received background message ', payload);
    
    const notificationTitle = payload.notification.title || 'GMDS Notification';
    const notificationOptions = {
        body: payload.notification.body || 'You have a new message.',
        icon: '/logo.png', // আপনার ওয়েবসাইটের লোগোর পাথ
        badge: '/logo.png'
    };

    self.registration.showNotification(notificationTitle, notificationOptions);
});
