const errorHandler = (error, req, res, next) => {
  console.error(error);

  const statusCode = error.statusCode || error.status || 500;

  return res.status(statusCode).json({
    message: error.message || "Internal server error",
  });
};

module.exports = errorHandler;
