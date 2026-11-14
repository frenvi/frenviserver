const express = require('express');
const router = express.Router();
const catalogController = require('../controllers/catalogController');

// GET /api/catalog — full userTypes + industries + designations (Cloudinary photos)
router.get('/', catalogController.getFullCatalog);

// GET /api/catalog/designations?industryId=&userTypeId=
router.get('/designations', catalogController.getDesignations);

module.exports = router;
