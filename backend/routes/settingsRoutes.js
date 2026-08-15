const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const adminMiddleware = require('../middleware/adminMiddleware');
const settingsController = require('../controllers/settingsController');

// All mail settings endpoints require a logged-in admin.
router.use(authMiddleware, adminMiddleware);

router.get('/mail', settingsController.getMailSettings);
router.put('/mail', settingsController.updateMailSettings);
router.post('/mail/test', settingsController.testMailSettings);

module.exports = router;
