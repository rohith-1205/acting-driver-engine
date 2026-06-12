// Ride ID Generator: generates unique deterministic ride identifiers prefixed for acting drivers.

/**
 * Generates an acting driver ride ID: AD{REGIONCODE}{DDMMYY}{6-digit-random-number}
 * @param {string} regionCode - Region code prefix (e.g. "CMR")
 * @param {Date} [testDate] - Optional date argument to override current timestamp for deterministic testing
 * @returns {string}
 */
const generateActingDriverRideId = (regionCode, testDate) => {
  if (!regionCode || typeof regionCode !== 'string') {
    throw new Error('regionCode parameter is required and must be a string.');
  }

  const dateObj = testDate instanceof Date ? testDate : new Date();

  // Format DDMMYY
  const dd = String(dateObj.getDate()).padStart(2, '0');
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const yy = String(dateObj.getFullYear()).slice(-2);
  const ddmmyy = `${dd}${mm}${yy}`;

  // Generate 6-digit random number (000000 - 999999), zero-padded
  const randomVal = Math.floor(Math.random() * 1000000);
  const randomStr = String(randomVal).padStart(6, '0');

  const regionUpper = regionCode.toUpperCase();

  return `AD${regionUpper}${ddmmyy}${randomStr}`;
};

module.exports = {
  generateActingDriverRideId
};
