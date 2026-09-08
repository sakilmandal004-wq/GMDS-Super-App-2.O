const express = require('express');
const cors = require('cors');

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// বেসিক API রুট (সার্ভার চেক করার জন্য)
app.get('/', (req, res) => {
    res.json({
        status: "success",
        message: "GMDS Secure Backend is Live & Running! 🚀",
        version: "1.0.0"
    });
});

// ফুড ডেলিভারি বা অন্য কোনো সার্ভিসের ডেমো API (ভবিষ্যতের জন্য)
app.get('/api/status', (req, res) => {
    res.json({
        services: "Active",
        delivery: "Operational",
        support: "24/7 Available"
    });
});

// সার্ভার চালু করা
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`✅ GMDS Backend running on port ${PORT}`);
    console.log(`=================================`);
});
