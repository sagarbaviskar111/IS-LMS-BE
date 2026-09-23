const jwt = require("jsonwebtoken");

const generatePortfolioToken = (portfolioUser) => {
  return jwt.sign(
    { id: portfolioUser._id, type: "portfolio" },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || "7d" }
  );
};

module.exports = generatePortfolioToken;
