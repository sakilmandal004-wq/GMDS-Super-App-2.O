const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit'); // 🛡️ সিকিউরিটি ও স্প্যাম প্রতিরোধের জন্য রেট লিমিটার

const app = express();

// 🚀 প্রক্সি ট্রাস্ট সেটিং (Render-এর জন্য বাধ্যতামূলক, এটি IP Error ঠিক করবে)
app.set('trust proxy', 1);

// Middleware: Enable Cross-Origin Resource Sharing and JSON body parsing
app.use(express.json());
app.use(cors());

// 🛡️ ১. গ্লোবাল রেট লিমিটার (প্রতি ১৫ মিনিটে একটি আইপি থেকে সর্বোচ্চ ১০০টি রিকোয়েস্ট)
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100,
    message: {
        status: "error",
        message: "Too many requests from this IP, please try again later."
    },
    standardHeaders: true, 
    legacyHeaders: false, 
});

// 🛡️ ২. অর্ডার ও বুকিং এপিআই-র জন্য কড়া লিমিট (প্রতি ৫ মিনিটে সর্বোচ্চ ৩টি অর্ডার)
const orderLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, 
    max: 3, 
    message: {
        status: "error",
        message: "Security Lock: You are placing orders too fast. Please wait a few minutes."
    }
});

// গ্লোবাল লিমিট সব এপিআই-র ওপর অ্যাপ্লাই করা হলো
app.use('/api/', globalLimiter);

// 1. Server Health Check API
app.get('/', (req, res) => {
    res.json({
        status: "success",
        message: "GMDS Secure Backend is Live & Running! 🚀",
        version: "2.0.0"
    });
});

// 2. User Activity & Action Logging API (Replaces Google Apps Script)
app.post('/api/log', (req, res) => {
    const { name, phone, service, location, address, timestamp } = req.body;
    
    // Logs activity to the server console (undefined এড়াতে || 'Unknown' ব্যবহার করা হলো)
    console.log(`📝 [LOG] ${name || 'Unknown'} (${phone || 'N/A'}) - Service: ${service || 'N/A'}`);
    
    res.json({ 
        status: "success", 
        message: "Data logged securely via Backend" 
    });
});

// 3. Multi-Sector Order Processing API (এখানে স্প্যাম রোধে কড়া অর্ডার লিমিটার বসানো হলো)
app.post('/api/place-order', orderLimiter, (req, res) => {
    const orderData = req.body;
    
    // 🛠️ ডাইনামিক ডেটা হ্যান্ডলিং (undefined সমস্যা সমাধানের জন্য)
    const customerName = orderData.user || orderData.customer || orderData.name || "Unknown";
    const orderAmount = orderData.grandTotal || orderData.price || "N/A";
    const paymentMode = orderData.payMode || "Cash";

    // Order reception and backend validation logging
    console.log(`🛒 [NEW ORDER] ID: ${orderData.orderId} | By: ${customerName}`);
    console.log(`💰 Total: ₹${orderAmount} | Mode: ${paymentMode}`);
    console.log(`📦 Service Type: ${orderData.type || orderData.service || 'General'}`);

    // Standardized JSON response
    res.json({ 
        status: "success", 
        message: "Order verified and processed successfully.",
        orderId: orderData.orderId
    });
});

// 4. Online Payment Integration (Placeholder for Razorpay/UPI)
app.post('/api/payment/create', (req, res) => {
    const { amount, phone } = req.body;
    console.log(`💳 [PAYMENT REQUEST] Amount: ₹${amount || '0'} for ${phone || 'Unknown'}`);
    
    // Server-side Razorpay order creation logic will execute here
    res.json({ 
        status: "pending", 
        transaction_id: "txn_" + Date.now() 
    });
});

// Dynamic Server Port Configuration
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`✅ GMDS Secure Backend running on port ${PORT}`);
    console.log(`=================================`);
});
