// Reads ?page= and ?limit= off the request, clamped to sane bounds.
const paginate = (req, defaultLimit = 10, maxLimit = 500) => {
  let page = parseInt(req.query.page, 10);
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(limit) || limit < 1) limit = defaultLimit;
  if (limit > maxLimit) limit = maxLimit;
  return { page, limit, skip: (page - 1) * limit };
};

module.exports = paginate;
