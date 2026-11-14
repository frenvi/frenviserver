const { UserType, Industry, Designation } = require('../models/Catalog');
const { isConnected } = require('../config/db');

const catalogController = {
  async getFullCatalog(req, res) {
    try {
      if (!isConnected()) {
        return res.status(503).json({
          success: false,
          message: 'Database offline'
        });
      }

      const [userTypes, industries, designations] = await Promise.all([
        UserType.find().sort({ title: 1 }).lean(),
        Industry.find().sort({ title: 1 }).lean(),
        Designation.find().sort({ title: 1 }).lean()
      ]);

      return res.json({
        success: true,
        data: {
          userTypes,
          industries,
          designations
        },
        meta: {
          userTypes: userTypes.length,
          industries: industries.length,
          designations: designations.length
        }
      });
    } catch (err) {
      console.error('Catalog fetch error:', err);
      return res.status(500).json({ success: false, message: 'Server error loading catalog' });
    }
  },

  async getDesignations(req, res) {
    try {
      const { industryId, userTypeId } = req.query;
      if (!isConnected()) {
        return res.status(503).json({ success: false, message: 'Database offline', data: [] });
      }

      const query = {};
      if (industryId) query.industryId = industryId;
      if (userTypeId) query.userTypes = userTypeId;

      const designations = await Designation.find(query).sort({ title: 1 }).lean();
      return res.json({ success: true, data: designations });
    } catch (err) {
      console.error('Designations fetch error:', err);
      return res.status(500).json({ success: false, message: 'Server error', data: [] });
    }
  }
};

module.exports = catalogController;
