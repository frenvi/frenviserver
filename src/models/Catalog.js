const mongoose = require('mongoose');

const CategorySchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    desc: { type: String, default: '' },
    photo: { type: String, default: '' }
  },
  { _id: false }
);

const UserTypeSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    desc: { type: String, default: '' },
    photo: { type: String, default: '' },
    icon: { type: String, default: '' }
  },
  { timestamps: true }
);

const IndustrySchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    count: { type: Number, default: 0 },
    status: { type: String, default: '' },
    photo: { type: String, default: '' },
    icon: { type: String, default: '' }
  },
  { timestamps: true }
);

const DesignationSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    industryId: { type: String, required: true, index: true },
    industry: { type: String, default: '' },
    icon: { type: String, default: '' },
    photo: { type: String, default: '' },
    fallbackPhoto: { type: String, default: '' },
    desc: { type: String, default: '' },
    userTypes: { type: [String], default: [] },
    categories: { type: [CategorySchema], default: [] }
  },
  { timestamps: true }
);

DesignationSchema.index({ industryId: 1, title: 1 });

module.exports = {
  UserType: mongoose.model('UserType', UserTypeSchema),
  Industry: mongoose.model('Industry', IndustrySchema),
  Designation: mongoose.model('Designation', DesignationSchema)
};
