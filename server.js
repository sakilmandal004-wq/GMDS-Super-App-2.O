const express = require('express');
const cors = require('cors');

const app = express();

// Middleware: Enable Cross-Origin Resource Sharing and JSON body parsing
app.use(express.json());
app.use(cors());

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
    
    // Logs activity to the server console (can be routed to MongoDB/Firebase later)
    console.log(`📝 [LOG] ${name} (${phone}) - Service: ${service}`);
    
    res.json({ 
        status: "success", 
        message: "Data logged securely via Backend" 
    });
});

// 3. Multi-Sector Order Processing API
app.post('/api/place-order', (req, res) => {
    const orderData = req.body;
    
    // Order reception and backend validation logging
    console.log(`🛒 [NEW ORDER] ID: ${orderData.orderId} | By: ${orderData.user}`);
    console.log(`💰 Total: ₹${orderData.grandTotal} | Mode: ${orderData.payMode}`);

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
    console.log(`💳 [PAYMENT REQUEST] Amount: ₹${amount} for ${phone}`);
    
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
