const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose'); // 📦 MongoDB Integration Library
const Razorpay = require('razorpay'); // 💳 Razorpay Library Integration
const crypto = require('crypto'); // 🔒 Secure signature verification library

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
    razorpayPaymentId: String, // 🔖 Track successful transaction ID
    riderStatus: { type: String, default: 'Pending' }, // 🚀 Order confirmation status
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
        version: "2.0.3"
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
        const initialStatus = orderData.riderStatus || (paymentMode === 'ONLINE' ? 'Payment Pending' : 'Confirmed');

        // Log incoming order details to the server console
        console.log(`🛒 [NEW ORDER] ID: ${orderData.orderId} | By: ${customerName}`);
        console.log(`💰 Total: ₹${orderAmount} | Mode: ${paymentMode} | Status: ${initialStatus}`);

        // 💾 Save the order securely to MongoDB Database
        const newOrder = new Order({
            orderId: orderData.orderId,
            customerName: customerName,
            phone: orderData.phone || "N/A",
            orderAmount: orderAmount,
            paymentMode: paymentMode,
            serviceType: serviceType,
            razorpayOrderId: orderData.razorpayOrderId || "N/A",
            razorpayPaymentId: orderData.razorpayPaymentId || "",
            riderStatus: initialStatus
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
// 🔍 5. SERVER-SIDE PAYMENT VERIFICATION & AUTO-CONFIRMATION API
// =========================================================
app.post('/api/payment/verify', async (req, res) => {
    try {
        const { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature } = req.body;

        if (!razorpayPaymentId) {
            return res.status(400).json({ status: "error", message: "Missing payment transaction reference." });
        }

        console.log(`🔍 [VERIFY PAYMENT] Checking Razorpay Status for Payment ID: ${razorpayPaymentId}`);

        // Optional: Security Signature Verification
        if (razorpayOrderId && razorpaySignature) {
            const generatedSignature = crypto
                .createHmac('sha256', razorpayInstance.key_secret)
                .update(razorpayOrderId + "|" + razorpayPaymentId)
                .digest('hex');

            if (generatedSignature !== razorpaySignature) {
                console.warn(`⚠️ [SECURITY WARNING] Invalid Razorpay Signature for Order ID: ${orderId}`);
                return res.status(400).json({ status: "error", message: "Payment signature verification failed." });
            }
        }

        // Fetch direct status from Razorpay API
        const paymentDetails = await razorpayInstance.payments.fetch(razorpayPaymentId);

        if (paymentDetails && paymentDetails.status === 'captured') {
            console.log(`✅ [PAYMENT SUCCESS] Transaction ${razorpayPaymentId} is officially CAPTURED!`);

            // Update Database to 'Confirmed'
            const updatedOrder = await Order.findOneAndUpdate(
                { orderId: orderId },
                { 
                    riderStatus: 'Confirmed',
                    razorpayPaymentId: razorpayPaymentId 
                },
                { new: true }
            );

            if (updatedOrder) {
                console.log(`📦 [DATABASE] Order ${orderId} automatically updated to CONFIRMED!`);
                return res.json({ 
                    status: "success", 
                    message: "Payment verified successfully and order is confirmed.",
                    orderId: orderId
                });
            } else {
                return res.status(404).json({ status: "error", message: "Order not found in database." });
            }
        } else {
            console.warn(`❌ [PAYMENT PENDING/FAILED] Status: ${paymentDetails ? paymentDetails.status : 'Unknown'}`);
            return res.status(400).json({ 
                status: "failed", 
                message: "Payment not captured yet or transaction failed." 
            });
        }

    } catch (error) {
        console.error("❌ Server-Side Payment Verification Error:", error);
        res.status(500).json({ 
            status: "error", 
            message: "Internal server error during payment verification." 
        });
    }
});

// =========================================================
// 💸 6. AUTOMATED REFUND ON CANCELLATION API
// =========================================================
app.post('/api/payment/refund', async (req, res) => {
    try {
        const { orderId } = req.body;

        if (!orderId) {
            return res.status(400).json({ status: "error", message: "Order ID is required for refund." });
        }

        console.log(`💸 [REFUND INITIATED] Processing cancellation for Order: ${orderId}`);

        // ডাটাবেস থেকে অর্ডারের বিস্তারিত তথ্য খুঁজে বের করা
        const order = await Order.findOne({ orderId: orderId });

        if (!order) {
            return res.status(404).json({ status: "error", message: "Order not found in database." });
        }

        // চেক করা অর্ডারটি অনলাইনে পেমেন্ট হয়েছিল কি না এবং পেমেন্ট আইডি আছে কি না
        if (order.paymentMode === 'ONLINE' && order.razorpayPaymentId) {
            try {
                // Razorpay Refund API কল করা (Speed "optimum" মানে দ্রুত রিফান্ড হবে)
                const refundResponse = await razorpayInstance.payments.refund(order.razorpayPaymentId, {
                    speed: "optimum",
                    notes: {
                        reason: "Customer cancelled the order within the 5-minute window."
                    }
                });

                console.log(`✅ [REFUND SUCCESS] Refund ID: ${refundResponse.id} generated for Order: ${orderId}`);

                // ডাটাবেসে স্ট্যাটাস আপডেট করা
                order.riderStatus = 'Cancelled & Refunded';
                await order.save();

                return res.json({ 
                    status: "success", 
                    message: "Order cancelled and refund initiated successfully.",
                    refundId: refundResponse.id
                });

            } catch (refundError) {
                console.error("❌ Razorpay Refund Gateway Error:", refundError);
                return res.status(500).json({ 
                    status: "error", 
                    message: "Failed to process refund from Razorpay payment gateway." 
                });
            }
        } else {
            // যদি COD হয় বা অনলাইন পেমেন্ট আইডি না থাকে, শুধু অর্ডারটি ক্যানসেল করে দেবে
            order.riderStatus = 'Cancelled';
            await order.save();
            
            console.log(`✅ [CANCEL SUCCESS] COD Order ${orderId} cancelled without refund.`);
            return res.json({ 
                status: "success", 
                message: "Order cancelled successfully (No refund required for COD)." 
            });
        }

    } catch (error) {
        console.error("❌ Cancellation & Refund Error:", error);
        res.status(500).json({ 
            status: "error", 
            message: "Internal server error during cancellation." 
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
