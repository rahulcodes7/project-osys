/* --- STATE MANAGEMENT --- */
let categories = [];
let items = [];
let cart = JSON.parse(localStorage.getItem('fsp_cart')) || [];
let user = JSON.parse(localStorage.getItem('user')) || null;
let currentCategory = 1;
let selectedAddonItem = null; // Temporary holder for addon selection
let selectedAddress = null;   // Temporary holder for checkout
let orderTimer = null;
let orderLimit = 7;

// API Base URL
const API_URL = '/api';

/* --- INITIALIZATION --- */
document.addEventListener('DOMContentLoaded', () => {
    // Only init menu if we are on index page
    if(document.getElementById('category-list')) {
        fetchMenu();
        renderNavbar();
        updateCartUI();
    }
});

/* --- NAVBAR & AUTH --- */
function renderNavbar() {
    const rhs = document.getElementById('nav-rhs');
    if(!rhs) return;
    
    if (user) {
        rhs.innerHTML = `
            <a href="orders.html" class="nav-icon">📦</a>
            <a href="profile.html" class="nav-icon">👤</a>
        `;
    } else {
        rhs.innerHTML = `<span class="nav-icon" onclick="openLogin()">Login</span>`;
    }
}

function openLogin() {
    document.getElementById('login-popup').style.display = 'flex';
}

function sendOtp() {
    const mobile = document.getElementById('mobile-input').value;
    if(!mobile) return alert('Enter mobile');
    
    fetch(`${API_URL}/auth/otp`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ mobile })
    })
    .then(res => res.json())
    .then(data => {
        document.getElementById('login-step-1').style.display = 'none';
        document.getElementById('login-step-2').style.display = 'block';
    });
}

function verifyOtp() {
    const mobile = document.getElementById('mobile-input').value;
    const otp = document.getElementById('otp-input').value;
    
    fetch(`${API_URL}/auth/verify`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ mobile, otp })
    })
    .then(res => res.json())
    .then(data => {
        if(data.success) {
            user = { id: data.userId, mobile: data.mobile };
            localStorage.setItem('user', JSON.stringify(user));
            closePopup('login-popup');
            renderNavbar();
            // If cart is open and waiting for auth, proceed
            if(document.getElementById('cart-popup').style.display === 'flex') {
                proceedToAddress();
            }
        } else {
            alert('Invalid OTP');
        }
    });
}

function logout() {
    localStorage.removeItem('user');
    window.location.href = 'index.html';
}

/* --- MENU RENDER --- */
function fetchMenu() {
    fetch(`${API_URL}/menu`)
        .then(res => res.json())
        .then(data => {
            categories = data.categories;
            items = data.items;
            renderCategories();
            renderItems(categories[0].id);
        });
}

function renderCategories() {
    const list = document.getElementById('category-list');
    list.innerHTML = categories.map(c => `
        <div class="cat-item ${c.id === currentCategory ? 'active' : ''}" onclick="switchCategory(${c.id})">
            <img src="images/${c.image}" class="cat-img" alt="${c.name}">
            <div class="cat-name">${c.name}</div>
        </div>
    `).join('');
}

function switchCategory(id) {
    currentCategory = id;
    renderCategories();
    renderItems(id);
}

function renderItems(catId) {
    const container = document.getElementById('item-list');
    const filteredItems = items.filter(i => i.categoryId === catId);
    
    container.innerHTML = `<div class="items-grid">
        ${filteredItems.map(item => {
            // Check if item is in cart (only valid for simple items without addons logic for button display)
            // For simplicity/requirement: 
            // - Has Addons: ALWAYS show ADD button (opens popup)
            // - No Addons: Show ADD or - QTY +
            
            const hasAddons = item.addons.length > 0;
            const inCart = cart.find(c => c.id === item.id && (!c.addons || c.addons.length === 0));
            
            let btnHtml = '';
            
            if (hasAddons) {
                btnHtml = `<button class="add-btn" onclick="openAddonPopup(${item.id})">ADD +</button>`;
            } else if (inCart) {
                btnHtml = `
                    <div class="qty-controls">
                        <button class="qty-btn" onclick="updateQty(${item.id}, -1, [])">-</button>
                        <span>${inCart.qty}</span>
                        <button class="qty-btn" onclick="updateQty(${item.id}, 1, [])">+</button>
                        <button class="qty-btn" style="background:#e74c3c" onclick="updateQty(${item.id}, -${inCart.qty}, [])">🗑</button>
                    </div>`;
            } else {
                btnHtml = `<button class="add-btn" onclick="addToCart(${item.id}, [])">ADD</button>`;
            }

            return `
            <div class="item-card">
                <img src="images/${item.image}" class="item-img" alt="${item.name}">
                <div class="item-details">
                    <div class="item-header">
                        <span class="item-name">${item.name}</span>
                        <span class="item-price">₹${item.price}</span>
                    </div>
                    ${btnHtml}
                </div>
            </div>`;
        }).join('')}
    </div>`;
}

/* --- CART & ADDONS --- */

function openAddonPopup(itemId) {
    const item = items.find(i => i.id === itemId);
    selectedAddonItem = item;
    
    const popup = document.getElementById('addon-popup');
    const list = document.getElementById('addon-list');
    
    list.innerHTML = item.addons.map(add => `
        <div class="addon-row">
            <label>
                <input type="checkbox" value="${add.id}" data-price="${add.price}" data-name="${add.name}" class="addon-check">
                ${add.name}
            </label>
            <span>+₹${add.price}</span>
        </div>
    `).join('');
    
    // Bind Confirm Button
    document.getElementById('confirm-addon-btn').onclick = () => {
        const checks = document.querySelectorAll('.addon-check:checked');
        const selectedAddons = Array.from(checks).map(c => ({
            id: c.value, 
            name: c.dataset.name, 
            price: parseInt(c.dataset.price)
        }));
        
        addToCart(selectedAddonItem.id, selectedAddons);
        closePopup('addon-popup');
    };
    
    popup.style.display = 'flex';
}

function addToCart(itemId, addons) {
    const item = items.find(i => i.id === itemId);
    
    // Check if identical item (same ID + same addons) exists
    // We sort addons by ID to ensure stringify matches
    const addonsStr = JSON.stringify(addons.sort((a,b) => a.id - b.id));
    
    const existing = cart.find(c => c.id === itemId && JSON.stringify(c.addons) === addonsStr);
    
    if (existing) {
        existing.qty++;
    } else {
        cart.push({
            id: item.id,
            name: item.name,
            price: item.price,
            qty: 1,
            addons: addons,
            addonsStr: addonsStr // Helper for comparison
        });
    }
    
    saveCart();
}

function updateQty(itemId, delta, addons) {
    const addonsStr = JSON.stringify(addons.sort((a,b) => a.id - b.id));
    const idx = cart.findIndex(c => c.id === itemId && JSON.stringify(c.addons) === addonsStr);
    
    if (idx > -1) {
        cart[idx].qty += delta;
        if (cart[idx].qty <= 0) {
            cart.splice(idx, 1);
        }
    }
    saveCart();
}

function saveCart() {
    localStorage.setItem('fsp_cart', JSON.stringify(cart));
    updateCartUI();
    // Re-render items if category view needs update (for non-addon items)
    if(document.getElementById('item-list')) renderItems(currentCategory);
}

function updateCartUI() {
    const btn = document.getElementById('view-cart-btn');
    if(!btn) return;
    
    const total = cart.reduce((sum, item) => {
        const itemTotal = (item.price + item.addons.reduce((a,b)=>a+b.price, 0)) * item.qty;
        return sum + itemTotal;
    }, 0);
    
    document.getElementById('cart-total-float').innerText = `₹${total}`;
    
    if (cart.length > 0) btn.style.display = 'flex';
    else btn.style.display = 'none';
}

function openCart() {
    const container = document.getElementById('cart-items-container');
    const totalEl = document.getElementById('cart-final-total');
    
    let total = 0;
    
    container.innerHTML = cart.map(item => {
        const basePrice = item.price;
        const addonPrice = item.addons.reduce((sum, a) => sum + a.price, 0);
        const unitPrice = basePrice + addonPrice;
        const lineTotal = unitPrice * item.qty;
        total += lineTotal;
        
        const addonText = item.addons.map(a => `<small>+ ${a.name}</small>`).join('<br>');

        // Need to pass addons to updateQty correctly. We serialize it to base64 or safe string?
        // Simpler: Just rely on UI index not accurate, let's use the object reference logic in loop? No.
        // We will pass the exact addons object in JS
        
        return `
        <div class="addon-row" style="display:block;">
            <div style="display:flex; justify-content:space-between;">
                <strong>${item.name}</strong>
                <span>₹${lineTotal}</span>
            </div>
            ${addonText ? `<div style="color:#666; font-size:0.8rem;">${addonText}</div>` : ''}
            <div class="qty-controls" style="width:100px; margin-top:5px;">
                <button class="qty-btn" onclick='handleCartQty(${item.id}, -1, ${JSON.stringify(item.addons)})'>-</button>
                <span>${item.qty}</span>
                <button class="qty-btn" onclick='handleCartQty(${item.id}, 1, ${JSON.stringify(item.addons)})'>+</button>
                <button class="qty-btn" style="background:#e74c3c" onclick='handleCartQty(${item.id}, -999, ${JSON.stringify(item.addons)})'>🗑</button>
            </div>
        </div>
        `;
    }).join('');
    
    totalEl.innerText = `₹${total}`;
    document.getElementById('cart-popup').style.display = 'flex';
}

// Wrapper to parse JSON in HTML attribute
window.handleCartQty = (id, delta, addons) => {
    updateQty(id, delta, addons);
    openCart(); // Re-render cart
};

/* --- CHECKOUT FLOW --- */

function proceedToAddress() {
    if (!user) {
        closePopup('cart-popup');
        openLogin();
        return;
    }
    
    closePopup('cart-popup');
    document.getElementById('address-popup').style.display = 'flex';
    document.getElementById('confirm-contact').value = user.mobile;
    
    // Fetch addresses
    fetch(`${API_URL}/addresses/${user.id}`)
        .then(res => res.json())
        .then(data => {
            const savedDiv = document.getElementById('saved-addresses');
            const dummyDiv = document.getElementById('dummy-addresses');
            
            savedDiv.innerHTML = data.saved.map(a => `
                <div class="addr-card" onclick="selectAddress(this, '${a.id}', '${a.contact_name}', '${a.contact_number}')">
                    <small><b>${a.contact_name}</b> (${a.contact_number})</small><br>
                    Address ID: ${a.address_id} </div>
            `).join('');

            // Store dummy data for search
            window.dummyAddresses = data.dummy;
            renderDummyAddresses(data.dummy);
        });
}

function renderDummyAddresses(list) {
    document.getElementById('dummy-addresses').innerHTML = list.map(a => `
        <div class="addr-card dummy" onclick="selectAddress(this, '${a.id}', '', '')">
            ${a.address_text}
        </div>
    `).join('');
}

function filterAddresses() {
    const term = document.getElementById('addr-search').value.toLowerCase();
    const filtered = window.dummyAddresses.filter(a => a.address_text.toLowerCase().includes(term));
    renderDummyAddresses(filtered);
}

function selectAddress(el, id, name, contact) {
    document.querySelectorAll('.addr-card').forEach(d => d.style.borderColor = '#eee');
    el.style.borderColor = 'var(--success)';
    
    selectedAddress = { id };
    if(name) document.getElementById('confirm-name').value = name;
    if(contact) document.getElementById('confirm-contact').value = contact;
}

function startPlaceOrder() {
    if(!selectedAddress) return alert('Select Address');
    const name = document.getElementById('confirm-name').value;
    const contact = document.getElementById('confirm-contact').value;
    
    if(!name || !contact) return alert('Name and Contact required');
    
    const btn = document.getElementById('place-order-btn');
    const cancelMsg = document.getElementById('cancel-msg');
    
    if (orderTimer) {
        // Cancel Action
        clearTimeout(orderTimer);
        orderTimer = null;
        btn.classList.remove('loading-fill');
        btn.innerText = 'Place Order';
        cancelMsg.style.display = 'none';
        return;
    }
    
    // Start Timer
    btn.classList.add('loading-fill');
    btn.innerText = 'Click to Cancel (3s)';
    cancelMsg.style.display = 'block';
    
    orderTimer = setTimeout(() => {
        // Execute Order
        const total = cart.reduce((sum, item) => sum + ((item.price + item.addons.reduce((a,b)=>a+b.price, 0)) * item.qty), 0);
        
        const payload = {
            userId: user.id,
            addressData: { id: selectedAddress.id, name, contact },
            cartItems: cart,
            total: total
        };
        
        fetch(`${API_URL}/orders`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        })
        .then(res => res.json())
        .then(data => {
            alert('Order Placed! ID: ' + data.orderId);
            cart = [];
            saveCart();
            window.location.href = 'orders.html';
        });
        
    }, 3000);
}

/* --- ORDER HISTORY & PROFILE --- */

function loadOrders(append = false) {
    if(!append) document.getElementById('orders-list').innerHTML = '';
    
    const currentCount = document.querySelectorAll('.order-card').length;
    const limit = append ? currentCount + 10 : 7;
    
    fetch(`${API_URL}/orders/${user.id}?limit=${limit}`)
        .then(res => res.json())
        .then(orders => {
            const container = document.getElementById('orders-list');
            container.innerHTML = orders.map(o => `
                <div class="order-card">
                    <div style="display:flex; justify-content:space-between">
                        <strong>Order #${o.id}</strong>
                        <span style="color:var(--primary)">₹${o.total_amount}</span>
                    </div>
                    <small>${new Date(o.created_at).toLocaleString()}</small><br>
                    <small>Status: ${o.status}</small>
                </div>
            `).join('');
            
            if(orders.length < limit || orders.length >= 57) {
                const btn = document.getElementById('load-more-btn');
                if(btn) btn.style.display = 'none';
            }
        });
}

function loadProfile() {
    if(!user) return window.location.href = 'index.html';
    document.getElementById('profile-mobile').innerText = user.mobile;
    
    fetch(`${API_URL}/addresses/${user.id}`)
        .then(res => res.json())
        .then(data => {
            document.getElementById('profile-addresses').innerHTML = data.saved.map(a => `
                <div class="addr-card">
                    <b>${a.contact_name}</b><br>${a.contact_number}
                </div>
            `).join('');
        });
}

/* --- UTILS --- */
function closePopup(id) {
    document.getElementById(id).style.display = 'none';
}