require('dotenv').config();
const express = require('express');
const withdrawalRoutes = require('./api/withdrawal_routes');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve the dashboard static files
app.use(express.static('dashboard'));

// API routes
app.use('/api/v2/withdrawal', withdrawalRoutes);

// Root path serves the dashboard
app.get('/', (_req, res) => {
  res.sendFile(__dirname + '/dashboard/index.html');
});

app.listen(PORT, () => {
  console.log(`[INFO] Server is running on http://localhost:${PORT}`);
});