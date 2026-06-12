// Driver Model: defines the Mongoose schema and indexes for acting driver profiles.
const mongoose = require('mongoose');

const LocationSchema = new mongoose.Schema({
  /** GeoJSON geometry type, defaults to Point */
  type: {
    type: String,
    enum: ["Point"],
    default: "Point"
  },
  /** Longitude and latitude coordinates: [longitude, latitude] */
  coordinates: {
    type: [Number],
    required: true
  },
  /** Epoch timestamp when location was updated */
  updatedAt: { type: Number },
  /** Accuracy of location in meters */
  accuracy: { type: Number },
  /** Direction in degrees */
  heading: { type: Number },
  /** Battery percentage at time of location update */
  battery: { type: Number }
}, { _id: false });

const HomeLocationSchema = new mongoose.Schema({
  /** GeoJSON geometry type, e.g. "Point" */
  type: {
    type: String,
    enum: ["Point"],
    default: "Point"
  },
  /** Home location coordinates as [longitude, latitude] */
  coordinates: {
    type: [Number],
    required: true
  },
  /** Friendly address representation */
  addressName: { type: String }
}, { _id: false });

const DriverSchema = new mongoose.Schema({
  /** Driver phone number */
  phone: {
    type: String,
    required: true,
    unique: true
  },
  /** Driver full name */
  name: {
    type: String,
    required: true
  },
  /** Driver role, must be "acting_driver" for acting driver trips */
  role: {
    type: String,
    required: true
  },
  /** Boolean indicating eligibility for acting driver trips */
  isActingDriver: {
    type: Boolean,
    required: true
  },
  /** Active profiles/modes of the driver (e.g. ["dco", "acting_driver"]) */
  mode: [String],
  /** Flag showing if driver profile is approved by administrative nodes */
  isApproved: {
    type: Boolean
  },
  /** Availability state indicating if driver is free to receive ride jobs */
  isAvailable: {
    type: Boolean
  },
  /** Administrative block flag */
  isBlocked: {
    type: Boolean
  },
  /** Soft delete marker */
  isDeleted: {
    type: Boolean
  },
  /** Active trip occupancy status */
  tripStatus: {
    type: String,
    enum: ["NOTRIP", "ONTRIP"]
  },
  /** Connection state details, online or offline */
  driverStatus: {
    status: { type: String },
    updatedOn: { type: Number }
  },
  /** Geographical position coordinates of driver */
  location: {
    type: LocationSchema,
    required: true
  },
  /** Set home coordinates for returning-home matching logic */
  homeLocation: {
    type: HomeLocationSchema
  },
  /** Reference to regional center assigned to supervise driver */
  regionalOffice: {
    type: mongoose.Schema.Types.ObjectId
  },
  /** Rating feedback metrics */
  ratingData: {
    currentrating: { type: Number },
    count: { type: Number },
    total: { type: Number }
  },
  /** Total number of rides accepted */
  totalTripsAccepted: {
    type: Number
  },
  /** Total number of matches rejected by the driver */
  totalTripsRejected: {
    type: Number
  },
  /** Epoch timestamp of the last finished trip */
  lastTripTime: {
    type: Number
  },
  /** Professional profile details representing experience level */
  experience: {
    vehicleTypes: [String],
    vehicleHandling: [String],
    transmission: [String],
    fuelTypes: [String],
    longDistance: { type: Boolean },
    nightDriving: { type: Boolean },
    totalExperience: { type: String },
    commercialExperience: { type: String },
    hasPlatformExperience: { type: Boolean },
    platforms: [String],
    approxTrips: { type: String },
    driverRating: { type: String }
  },
  /** List of upcoming scheduled trip IDs to prevent scheduling overlaps */
  upComingTrips: [
    {
      type: mongoose.Schema.Types.Mixed // ObjectId or String
    }
  ],
  /** Buffer time in minutes between scheduled trips */
  calendarBufferMinutes: {
    type: Number,
    default: 120,   // 2 hours default
    min: 60,        // 1 hour minimum
    max: 480        // 8 hours maximum
  },
  /** Assigned physical vehicle ID, if any (DCO mode specific) */
  vehicleId: {
    type: mongoose.Schema.Types.Mixed // ObjectId or String
  },
  /** FCM push notification configuration */
  fcmToken: {
    token: { type: String },
    deviceImei: { type: String },
    isUpdated: { type: Boolean }
  },
  /** Client application device information */
  deviceMeta: {
    os: { type: String },
    osVersion: { type: String },
    appVersion: { type: String },
    buildNumber: { type: String },
    brand: { type: String },
    model: { type: String }
  },
  /** Live device metrics reported in real-time */
  liveStats: {
    battery: { type: Number },
    speed: { type: Number },
    lastLocationUpdatedOn: { type: Number },
    course: { type: Number },
    activity: { type: String }
  },
  /** Due cycles for driver accounting and billing */
  dueCycle: {
    type: mongoose.Schema.Types.Mixed
  },
  /** Outstanding system fee due from the driver */
  driverDue: {
    type: Number
  },
  /** Aggregated platform earnings for driver */
  driverEarnings: {
    type: Number
  },
  /** Registered vendor link ID */
  vendorIdn: {
    type: mongoose.Schema.Types.ObjectId
  },
  /** Approving admin reference */
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId
  },
  /** Date approved */
  approvedOn: {
    type: Number
  },
  /** Custom track epochs */
  lastUpdatedAt: { type: Number },
  createdOn: { type: Number }
}, {
  timestamps: true,
  collection: 'drivers'
});

// Indexes
DriverSchema.index({ location: "2dsphere" });
DriverSchema.index({ isActingDriver: 1, isApproved: 1, isAvailable: 1 });
DriverSchema.index({ "driverStatus.status": 1 });
DriverSchema.index({ regionalOffice: 1 });
DriverSchema.index({ tripStatus: 1 });

module.exports = mongoose.model('Driver', DriverSchema);
