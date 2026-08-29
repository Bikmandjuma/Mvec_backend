const validate = (validator) => (req, res, next) => {
  try {
    const errors = validator(req.body, req);

    if (errors && errors.length > 0) {
      return res.status(400).json({
        message: "Validation failed",
        errors,
      });
    }

    return next();
  } catch (error) {
    return next(error);
  }
};

module.exports = validate;
