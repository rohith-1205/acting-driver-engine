// Vehicle Model: defines the Mongoose schema and indexes for passenger vehicles.
const mongoose = require('mongoose');

const VehicleSchema = new mongoose.Schema({
  /** Owner ID referencing the passenger's User document */
  ownerId: {
    type: mongoose.Schema.Types.Mixed, // ObjectId or String
    required: true
  },
  /** Category type of vehicle (e.g. hatchback, sedan, suv) */
  vehicleType: {
    type: String,
    required: true
  },
  /** Brand make of the vehicle (e.g. Toyota, Honda) */
  make: {
    type: String
  },
  /** Specific model name (e.g. Corolla, Civic) */
  model: {
    type: String
  },
  /** Manufacture year */
  year: {
    type: Number
  },
  /** License plate / registration code */
  registrationNumber: {
    type: String
  },
  /** Exterior body color */
  color: {
    type: String
  },
  /** Fuel configuration class (e.g. Petrol, Diesel, Hybrid) */
  fuelType: {
    type: String
  },
  /** Transmission gearbox mode */
  transmission: {
    type: String,
    enum: ["manual", "automatic"]
  },
  /** Active status indicator for the vehicle */
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true,
  collection: 'vehicles'
});

// Indexes
VehicleSchema.index({ ownerId: 1, isActive: 1 });

module.exports = mongoose.model('Vehicle', VehicleSchema);
