const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const portfolioUserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 6, select: false },
    dob: { type: Date, required: true },
    slug: { type: String, required: true, unique: true },
    headline: { type: String, trim: true, default: "" },
    bio: { type: String, trim: true, default: "" },
    phone: { type: String, trim: true, default: "" },
    location: { type: String, trim: true, default: "" },
    profilePicture: {
      cloudinaryPublicId: { type: String, default: null },
      cloudinaryResourceType: { type: String, default: null },
    },
    backgroundImage: {
      cloudinaryPublicId: { type: String, default: null },
      cloudinaryResourceType: { type: String, default: null },
    },
    socialLinks: {
      linkedin: { type: String, trim: true, default: "" },
      naukri: { type: String, trim: true, default: "" },
      github: { type: String, trim: true, default: "" },
      website: { type: String, trim: true, default: "" },
    },
    education: [
      {
        institution: { type: String, required: true, trim: true },
        degree: { type: String, required: true, trim: true },
        fieldOfStudy: { type: String, trim: true },
        startYear: { type: String, trim: true },
        endYear: { type: String, trim: true },
        grade: { type: String, trim: true },
        description: { type: String, trim: true },
      },
    ],
    experience: [
      {
        company: { type: String, required: true, trim: true },
        role: { type: String, required: true, trim: true },
        startDate: { type: String, trim: true },
        endDate: { type: String, trim: true },
        current: { type: Boolean, default: false },
        description: { type: String, trim: true },
      },
    ],
    projects: [
      {
        title: { type: String, required: true, trim: true },
        description: { type: String, trim: true },
        techStack: [{ type: String, trim: true }],
        link: { type: String, trim: true },
        github: { type: String, trim: true },
      },
    ],
    skills: [{ type: String, trim: true }],
    achievements: [
      {
        title: { type: String, required: true, trim: true },
        description: { type: String, trim: true },
        date: { type: String, trim: true },
      },
    ],
  },
  { timestamps: true }
);

portfolioUserSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 10);
});

portfolioUserSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

portfolioUserSchema.set("toJSON", {
  transform: (doc, ret) => {
    delete ret.password;
    return ret;
  },
});

module.exports = mongoose.model("PortfolioUser", portfolioUserSchema);
