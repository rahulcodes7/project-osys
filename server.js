require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const axios = require('axios'); // For WhatsApp Cloud API
const path = require('path');
const http = require('https');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// MySQL Connection
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// test connection
db.getConnection((err, conn) => {
    if (err) {
        console.error('MySQL Pool Error:', err);
    } else {
        console.log('MySQL Pool Connected');
        conn.release();
    }
});

// --- ROUTES ---

// 1. Get Menu (FROM DATABASE)
app.get('/api/menu', (req, res) => {
    
    // Step 1: Fetch Categories
    const catSql = 'SELECT * FROM categories';
    
    db.query(catSql, (err, categories) => {
        if (err) {
            console.error("Error fetching categories:", err);
            return res.status(500).json({ error: "Database error" });
        }

        // Step 2: Fetch Items
        // We select columns and rename them (alias) to match what the Frontend expects
        // e.g., category_id becomes categoryId, base_price becomes price
        const itemSql = `
            SELECT 
                id, 
                category_id AS categoryId, 
                name, 
                price, 
                image, 
                description 
            FROM items`;

        db.query(itemSql, (err, itemsRaw) => {
            if (err) {
                console.error("Error fetching items:", err);
                return res.status(500).json({ error: "Database error" });
            }

            // Step 3: Process Items
            // MySQL JSON columns might come back as strings or objects depending on the driver version.
            // We ensure 'addons' is always a valid array.
            const items = itemsRaw.map(item => ({
                id: item.id,
                categoryId: item.categoryId,
                name: item.name,
                price: item.price,
                image: item.image,
                description: item.description,
                // Ensure addons is an array (handle if it's returned as string or object)
                addons: []
            }));

            // Send combined response
            res.json({ categories, items });
        });
    });
});

// 2. Auth - Send OTP (PROPER)
app.post('/api/auth/otp', async (req, res) => {
    const { mobile } = req.body;
    if (!mobile) return res.status(400).json({ error: "Mobile required" });

    // Generate 4-digit OTP and 5-minute expiry
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const expiry = new Date(Date.now() + 5 * 60000); // 5 mins from now

    // Check if user exists to Update OR Insert
    const checkSql = 'SELECT id FROM users WHERE mobile = ?';
    db.query(checkSql, [mobile], async (err, results) => {
        const sql = results.length > 0 
            ? 'UPDATE users SET otp_code = ?, otp_expiry = ? WHERE mobile = ?'
            : 'INSERT INTO users (otp_code, otp_expiry, mobile) VALUES (?, ?, ?)';
        
        db.query(sql, [otp, expiry, mobile], async (err) => {
            if (err) return res.status(500).json({ error: "DB Error" });

            // Send actual WhatsApp Message
            const success = await sendMsg91OTP(("91"  + "" + mobile).trim());
            if (success) {
                res.json({ success: true, message: "OTP sent via WhatsApp" });
            } else {
                res.status(500).json({ success: false, message: "Failed to send WhatsApp message" });
            }
        });
    });
});

// 3. Auth - Verify OTP (PROPER)
app.post('/api/auth/verify', (req, res) => {
    const { mobile, otp } = req.body;

    const sql = 'SELECT id, otp_code, otp_expiry FROM users WHERE mobile = ?';
    db.query(sql, [mobile], (err, results) => {
        if (err || results.length === 0) return res.status(404).json({ message: "User not found" });

        const user = results[0];
        const now = new Date();

        // Validate OTP and Expiry
        if (user.otp_code === otp && new Date(user.otp_expiry) > now) {
            // Clear OTP after successful login for security
            db.query('UPDATE users SET otp_code = NULL, otp_expiry = NULL WHERE id = ?', [user.id]);
            
            res.json({ 
                success: true, 
                userId: user.id, 
                mobile: mobile,
                message: "Login successful" 
            });
        } else {
            res.status(400).json({ 
                success: false, 
                message: user.otp_code !== otp ? "Invalid OTP" : "OTP Expired" 
            });
        }
    });
});

// 4. Get Addresses (Dummy List + User Saved)
app.get('/api/addresses/:userId', (req, res) => {
    const userId = req.params.userId;
    // Get dummy list
    db.query('SELECT * FROM addresses', (err, dummyAddrs) => {
        // Get user saved addresses
        db.query(`
            SELECT ua.* FROM user_addresses ua
            JOIN users u ON (u.user_address_new = ua.id OR u.user_address_old = ua.id)
            WHERE u.id = ?`, [userId], (err, userAddrs) => {
                res.json({ dummy: dummyAddrs, saved: userAddrs });
        });
    });
});

// 5. Place Order
app.post('/api/orders', (req, res) => {
    const { userId, addressData, cartItems, total } = req.body;

    // A. Save/Link User Address
    // Logic: Insert into user_addresses, then update users table LIFO style
    const insertAddrSql = 'INSERT INTO user_addresses (address_id, contact_name, contact_number) VALUES (?, ?, ?)';
    db.query(insertAddrSql, [addressData.id, addressData.name, addressData.contact], (err, result) => {
        if(err) return res.status(500).send(err);
        
        const newAddrId = result.insertId;

        // Update User's Last 2 Addresses
        db.query('SELECT user_address_new FROM users WHERE id = ?', [userId], (err, rows) => {
            const oldNew = rows[0].user_address_new;
            db.query('UPDATE users SET user_address_old = ?, user_address_new = ? WHERE id = ?', 
                [oldNew, newAddrId, userId]);
        });

        // B. Create Order
        const orderSql = 'INSERT INTO orders (user_id, delivery_address, total_amount) VALUES (?, ?, ?)';
        db.query(orderSql, [userId, newAddrId, total], (err, orderResult) => {
            const orderId = orderResult.insertId;

            // C. Insert Items
            const itemValues = cartItems.map(item => [
                orderId, item.id, item.price, item.qty, JSON.stringify(item.addons || [])
            ]);
            db.query('INSERT INTO order_items (order_id, item_id, base_price, quantity, selected_addons) VALUES ?', 
                [itemValues], (err) => {
                    if (err) console.error(err);
                    
                    // D. WhatsApp Notification (Meta Cloud API)
                    sendWhatsAppNotification(addressData.contact, orderId, total, cartItems);
                    
                    res.json({ success: true, orderId });
            });
        });
    });
});

// 6. Get Orders
app.get('/api/orders/:userId', (req, res) => {
    const limit = parseInt(req.query.limit) || 7;
    const sql = `SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`;
    db.query(sql, [req.params.userId, limit], (err, results) => {
        res.json(results);
    });
});

/**
 * Sends a detailed order summary to the Admin via WhatsApp
 */
async function sendWhatsAppNotification(userMobile, orderId, total, items, addressData) {
    const url = `https://graph.facebook.com/${process.env.WA_VERSION}/${process.env.WA_PHONE_NUMBER_ID}/messages`;
    
    // 1. Format the Item List for the message
    const itemListString = items.map((item, index) => {
        const addons = item.addons && item.addons.length > 0 
            ? `\n   └ Add-ons: ${item.addons.map(a => a.name).join(', ')}` 
            : '';
        return `${index + 1}. ${item.name} x${item.qty} - ₹${item.price}${addons}`;
    }).join('\n');

    // 2. Construct the full message body
    const messageBody = `🛍️ *New Order Received!*
--------------------------
*Order ID:* #${orderId}
*Customer:* ${addressData.name}
*Mobile:* ${userMobile}
*Alt Contact:* ${addressData.contact}

*Address:* ${addressData.address_text || 'Address details provided'}

*Items:*
${itemListString}

*Total Amount:* ₹${total}
--------------------------
_Please check the dashboard to confirm._`;

    // 3. Prepare the Payload
    // Note: To send a free-text 'text' message, the admin must have 
    // interacted with the number in the last 24 hours.
    const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: process.env.ADMIN_PHONE_NUMBER,
        type: "text",
        text: { body: messageBody }
    };

    try {
        const response = await axios.post(url, payload, {
            headers: { 
                'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`[Admin Notification] WhatsApp sent for Order #${orderId}`);
        return response.data;
    } catch (err) {
        console.error("[Admin Notification] Failed to send WhatsApp:", err.response?.data || err.message);
        // We don't throw error here to prevent the order placement from failing 
        // if just the notification fails.
        return null;
    }
}

// Helper: Send WhatsApp Message via Meta API
async function sendWhatsAppOTP(mobile, otp) {
    const url = `https://graph.facebook.com/${process.env.WA_VERSION}/${process.env.WA_PHONE_NUMBER_ID}/messages`;
    
    const payload = {
        messaging_product: "whatsapp",
        to: "91" + mobile, // Format: 919876543210
        type: "template",
        template: {
            name: process.env.WA_TEMPLATE_NAME,
            language: { code: "en_US" }
            // components: [{
            //     type: "body",
            //     parameters: [{ type: "text", text: otp }]
            // }]
        }
    };

    try {
        await axios.post(url, payload, {
            headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` }
        });
        return true;
    } catch (err) {
        console.error("WhatsApp API Error:", err.response?.data || err.message);
        return false;
    }
}

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Webhook events
app.post('/webhook', (req, res) => {
  console.log('Webhook event received');
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

async function sendMsg91OTP(mobile) {

    const options = {
        method: 'POST',
        hostname: 'api.msg91.com',
        port: null,
        path: '/api/v5/widget/sendOtp',
        headers: {
            authkey: process.env.MSG91_API_KEY,
            'content-type': 'application/json'
        }
    };

    const req = http.request(options, function (res) {
        const chunks = [];

        res.on('data', function (chunk) {
            chunks.push(chunk);
        });

        res.on('end', function () {
            const body = Buffer.concat(chunks);
            console.log(body.toString());
        });
    });

    const data = JSON.stringify({
        widgetId: process.env.WIDGET_ID,     // STRING
        identifier: mobile                  // STRING, with country code
    });

    req.write(data);
    req.end();
}

async function verifyMsg91OTP(sentOTPRequestId, otp) {
    const options = {
        method: 'POST',
        hostname: 'api.msg91.com',
        port: null,
        path: '/api/v5/widget/verifyOtp',
        headers: {
            authkey: process.env.MSG91_API_KEY,
            'content-type': 'application/json'
        }
    };

    const req = http.request(options, function (res) {
        const chunks = [];

        res.on('data', function (chunk) {
            chunks.push(chunk);
        });

        res.on('end', function () {
            const body = Buffer.concat(chunks);
            console.log(body.toString());
        });
    });

    const data = JSON.stringify({
        widgetId: process.env.WIDGET_ID,     // string
        reqId: sentOTPRequestId,             // string (returned from sendOtp)
        otp: otp.toString()                  // string
    });

    req.write(data);
    req.end();
}

const PORT = process.env.PORT;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));