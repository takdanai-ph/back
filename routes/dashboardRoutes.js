const express = require('express');
const { protect, authorize } = require('../middleware/authMiddleware');
const router = express.Router();

router.get('/admin', protect, authorize(['Admin']), (req, res) => {
  res.json({ message: 'Welcome Admin' });
});

router.get('/manager', protect, authorize(['Admin', 'Manager']), (req, res) => {
  res.json({ message: 'Welcome Manager' });
});

router.get('/user', protect, authorize(['Admin', 'Manager', 'User']), (req, res) => {
  res.json({ message: 'Welcome User' });
});

module.exports = router;
