const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./db');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
require('dotenv').config();

const app = express();

// Configuración de Express
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Configuración de Sesión
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true
}));

// Middleware Global (Variables disponibles en todas las vistas)
app.use((req, res, next) => {
    if (!req.session.cart) req.session.cart = [];
    res.locals.user = req.session.user;
    res.locals.cart = req.session.cart;
    // Calcular cantidad total de items para el badge del carrito
    res.locals.cartQty = req.session.cart.reduce((acc, item) => acc + item.quantity, 0);
    next();
});

// --- RUTAS ---

// 1. Inicio (Catálogo)
app.get('/', (req, res) => {
    db.query('SELECT * FROM products', (err, results) => {
        if (err) throw err;
        res.render('index', { products: results });
    });
});

// 2. Autenticación
app.get('/login', (req, res) => res.render('login'));
app.get('/register', (req, res) => res.render('register'));

app.post('/register', async (req, res) => {
    const { username, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    
    db.query('INSERT INTO users SET ?', { username, email, password: hashedPassword }, (err) => {
        if (err) return res.send('<script>alert("Error o email duplicado"); window.location="/register"</script>');
        res.redirect('/login');
    });
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;
    db.query('SELECT * FROM users WHERE email = ?', [email], async (err, results) => {
        if (results.length > 0) {
            const match = await bcrypt.compare(password, results[0].password);
            if (match) {
                req.session.user = results[0];
                return res.redirect('/');
            }
        }
        res.send('<script>alert("Credenciales incorrectas"); window.location="/login"</script>');
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// 3. API del Carrito (AJAX)
app.post('/api/cart/add', (req, res) => {
    const { id, name, price, image } = req.body;
    const existing = req.session.cart.find(item => item.id == id);
    
    if (existing) {
        existing.quantity++;
    } else {
        req.session.cart.push({ id, name, price: parseFloat(price), image, quantity: 1 });
    }
    req.session.save(); // Asegurar guardado
    res.json({ success: true, cartLength: req.session.cart.length });
});

app.post('/api/cart/update', (req, res) => {
    const { id, action } = req.body;
    const cart = req.session.cart;
    const index = cart.findIndex(item => item.id == id);

    if (index !== -1) {
        if (action === 'increase') cart[index].quantity++;
        if (action === 'decrease') {
            cart[index].quantity--;
            if (cart[index].quantity <= 0) cart.splice(index, 1);
        }
        if (action === 'remove') cart.splice(index, 1);
    }
    
    const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    req.session.save();
    res.json({ success: true, cart, total });
});

app.get('/cart', (req, res) => {
    const total = req.session.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    res.render('cart', { total });
});

// 4. Checkout y PDF
app.post('/checkout', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.cart.length === 0) return res.redirect('/cart');

    const total = req.session.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const userId = req.session.user.id;
    const cartCopy = [...req.session.cart]; // Copia para el PDF antes de borrar sesión

    // Guardar Orden
    db.query('INSERT INTO orders (user_id, total) VALUES (?, ?)', [userId, total], (err, result) => {
        if (err) throw err;
        const orderId = result.insertId;
        
        // Guardar detalles
        const orderItems = cartCopy.map(item => [orderId, item.id, item.quantity, item.price]);
        db.query('INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ?', [orderItems], (err) => {
            if (err) throw err;

            // Limpiar carrito
            req.session.cart = [];
            
            // Generar PDF
            const doc = new PDFDocument();
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=ticket_orden_${orderId}.pdf`);
            
            doc.pipe(res);

            // Diseño del Ticket
            doc.fontSize(20).text('TECHSTORE - Comprobante', { align: 'center' });
            doc.moveDown();
            doc.fontSize(12).text(`Orden ID: #${orderId}`);
            doc.text(`Cliente: ${req.session.user.username}`);
            doc.text(`Fecha: ${new Date().toLocaleString()}`);
            doc.text('------------------------------------------------');
            doc.moveDown();
            
            cartCopy.forEach(item => {
                doc.text(`${item.name}`);
                doc.text(`Cant: ${item.quantity} x $${item.price.toFixed(2)} = $${(item.quantity * item.price).toFixed(2)}`);
                doc.moveDown(0.5);
            });
            
            doc.text('------------------------------------------------');
            doc.fontSize(16).text(`TOTAL PAGADO: $${total.toFixed(2)}`, { align: 'right' });
            
            doc.end();
        });
    });
});

// 5. Historial
app.get('/history', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    const sql = `
        SELECT o.id, o.total, o.date, 
        GROUP_CONCAT(CONCAT(p.name, ' (x', oi.quantity, ')') SEPARATOR ', ') as items 
        FROM orders o 
        JOIN order_items oi ON o.id = oi.order_id 
        JOIN products p ON oi.product_id = p.id 
        WHERE o.user_id = ? 
        GROUP BY o.id
        ORDER BY o.date DESC`;

    db.query(sql, [req.session.user.id], (err, results) => {
        if(err) console.log(err);
        res.render('history', { orders: results });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));