const jwt = require("jsonwebtoken");
const PortfolioUser = require("../models/PortfolioUser");

const protectPortfolio = async (req, res, next) => {
  try {
    const token = req.cookies?.portfolio_token;
    if (!token) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Rejects any JWT not minted by generatePortfolioToken (e.g. an
    // institute-tenant User's `token` cookie) from being replayed here.
    if (decoded.type !== "portfolio") {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const portfolioUser = await PortfolioUser.findById(decoded.id);
    if (!portfolioUser) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    req.portfolioUser = portfolioUser;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Not authenticated" });
  }
};

module.exports = { protectPortfolio };
