const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose'); // 📦 MongoDB Integration Library
const Razorpay = require('razorpay'); // 💳 Razorpay Library Integration

const app = express();

// 🚀 Proxy Trust Setting (Mandatory for Render to prevent IP errors)
app.set('trust proxy', 1);

// Middleware: Enable Cross-Origin Resource Sharing and JSON body parsing
app.use(express.json());
app.use(cors());

// =========================================================
// 💳 RAZORPAY CONFIGURATION (Live Keys Integrated)
// =========================================================
const razorpayInstance = new Razorpay({
    key_id: 'rzp_live_TbAMObdldQiFA3',
    key_secret: 'ubDKZovCOCseIbG4YQ3w3jN1'
});

// =========================================================
// 🛡️ SECURITY: API RATE LIMITERS
// =========================================================

// 1. Global Rate Limiter (Max 100 requests per 15 minutes per IP)
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

// 2. Strict Order Limiter (Max 3 orders per 5 minutes per IP to prevent spam)
const orderLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, 
    max: 3, 
    message: {
        status: "error",
        message: "Security Lock: You are placing orders too fast. Please wait a few minutes."
    }
});

// Apply global limiter to all /api/ routes
app.use('/api/', globalLimiter);

// =========================================================
// 💾 DATABASE: MONGODB CONNECTION & SCHEMAS
// =========================================================

// Connect to MongoDB Atlas using Render Environment Variable (or fallback)
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas successfully!'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

// Define Order Schema (Blueprint for database records)
const orderSchema = new mongoose.Schema({
    orderId: String,
    customerName: String,
    phone: String,
    orderAmount: String,
    paymentMode: String,
    serviceType: String,
    razorpayOrderId: String, // 💳 Track Razorpay secure order reference
    timestamp: { type: Date, default: Date.now }
});

const Order = mongoose.model('Order', orderSchema);

// =========================================================
// 🌐 SYSTEM API ROUTES
// =========================================================

// 1. Server Health Check API
app.get('/', (req, res) => {
    res.json({
        status: "success",
        message: "GMDS Secure Backend is Live & Running! 🚀",
        version: "2.0.1"
    });
});

// 2. User Activity & Action Logging API
app.post('/api/log', (req, res) => {
    const { name, phone, service, location, address, timestamp } = req.body;
    
    // Server console logging for activity monitoring
    console.log(`📝 [LOG] ${name || 'Unknown'} (${phone || 'N/A'}) - Service: ${service || 'N/A'}`);
    
    res.json({ 
        status: "success", 
        message: "Data logged securely via Backend." 
    });
});

// 3. Multi-Sector Order Processing API (Secured & Database Integrated)
app.post('/api/place-order', orderLimiter, async (req, res) => {
    try {
        const orderData = req.body;
        
        // Dynamic Data Handling (Prevents 'undefined' errors)
        const customerName = orderData.user || orderData.customer || orderData.name || "Unknown";
        const orderAmount = orderData.grandTotal || orderData.price || "N/A";
        const paymentMode = orderData.payMode || "Cash";
        const serviceType = orderData.type || orderData.service || 'General';

        // Log incoming order details to the server console
        console.log(`🛒 [NEW ORDER] ID: ${orderData.orderId} | By: ${customerName}`);
        console.log(`💰 Total: ₹${orderAmount} | Mode: ${paymentMode} | Service: ${serviceType}`);

        // 💾 Save the order securely to MongoDB Database
        const newOrder = new Order({
            orderId: orderData.orderId,
            customerName: customerName,
            phone: orderData.phone || "N/A",
            orderAmount: orderAmount,
            paymentMode: paymentMode,
            serviceType: serviceType,
            razorpayOrderId: orderData.razorpayOrderId || "N/A"
        });

        await newOrder.save();
        console.log(`💾 [DATABASE] Order ${orderData.orderId} saved to MongoDB Atlas!`);

        // Standardized JSON response to Frontend
        res.json({ 
            status: "success", 
            message: "Order verified and saved to database successfully.",
            orderId: orderData.orderId
        });
        
    } catch (error) {
        console.error("❌ Database Error while saving order:", error);
        res.status(500).json({ 
            status: "error", 
            message: "Internal server error while processing the database request." 
        });
    }
});

// =========================================================
// 💳 4. SECURE RAZORPAY PAYMENT & ORDER CREATION API
// =========================================================
app.post('/api/payment/create', async (req, res) => {
    try {
        const { amount, phone, orderId } = req.body;
        
        if (!amount || isNaN(amount) || amount <= 0) {
            return res.status(400).json({ status: "error", message: "Invalid payment amount specified." });
        }

        console.log(`💳 [PAYMENT REQUEST] Amount: ₹${amount} | Phone: ${phone || 'Unknown'} | Order: ${orderId || 'N/A'}`);

        // Options for Razorpay Order Generation (Amount converted to Paisa safely)
        const options = {
            amount: Math.round(Number(amount) * 100), // Ensuring strict integer paisa amount
            currency: "INR",
            receipt: "rcpt_" + (orderId || Date.now()),
            payment_capture: 1 // Auto-capture payment
        };

        // Create order securely via Razorpay API
        const razorpayOrder = await razorpayInstance.orders.create(options);
        
        console.log(`✅ [RAZORPAY] Secure Order Generated: ${razorpayOrder.id}`);

        res.json({ 
            status: "success", 
            key: "rzp_live_TbAMObdldQiFA3", // Safe public-facing live key for checkout initialization
            order_id: razorpayOrder.id,
            amount: razorpayOrder.amount,
            currency: razorpayOrder.currency
        });

    } catch (error) {
        console.error("❌ Razorpay Order Creation Error:", error);
        res.status(500).json({ 
            status: "error", 
            message: "Failed to initiate secure online payment gateway." 
        });
    }
});

// =========================================================
// 🚀 START SERVER INSTANCE
// =========================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`✅ GMDS Secure Backend running on port ${PORT}`);
    console.log(`=================================`);
});
