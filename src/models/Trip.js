// Trip Model: defines the Mongoose schema and indexes for acting driver trips.
const mongoose = require('mongoose');

/**
 * Stop schema for nested trip stops
 */
const StopSchema = new mongoose.Schema({
  /** The name or description of the stop location */
  name: { type: String },
  /** The coordinates of the stop as [longitude, latitude] */
  location: {
    type: [Number],
    validate: {
      validator: function(val) {
        return !val || val.length === 2;
      },
      message: 'Stop location must contain exactly [longitude, latitude]'
    }
  },
  /** The street address of the stop */
  address: { type: String },
  /** Estimated waiting time at this stop in minutes */
  waitingTime: { type: Number },
  /** Indicates if the driver has reached this stop */
  isReached: { type: Boolean, default: false },
  /** Epoch timestamp when the stop was reached */
  arrivalTime: { type: Number },
  /** Actual wait time of the driver at this stop in minutes */
  driverWaitTime: { type: Number },
  /** Flag showing if stop details were updated during the trip */
  stopUpdated: { type: Boolean },
  /** Epoch timestamp when this stop record was updated */
  updatedAt: { type: Number }
}, { _id: false });

/**
 * Ride match log schema to record matching workflow lifecycle events
 */
const RideMatchLogSchema = new mongoose.Schema({
  /** Event name description, e.g. "trip_request_attempt" */
  event: { type: String },
  /** Database ID of the candidate driver */
  driver_id: { type: String },
  /** Unique request identifier (UUID) generated for this match request */
  request_id: { type: String },
  /** Fare offered in this specific matching attempt */
  fare: { type: Number },
  /** Currency of the fare amount */
  currency: { type: String },
  /** Epoch timestamp of the matching event */
  timestamp: { type: Number },
  /** Response status, e.g. "accepted", "rejected", "timeout" */
  response: { type: String },
  /** Reason for rejection or failure */
  reason: { type: String },
  /** Escalation details if fare adjustment or bonus was applied */
  escalation_details: {
    escalation_count: { type: Number },
    estimated_fare: { type: Number },
    escalation_bonus: { type: Number }
  },
  /** Number of available drivers initially queried */
  driver_count: { type: Number },
  /** Profile details of all available drivers */
  drivers: { type: mongoose.Schema.Types.Mixed },
  /** Number of ranked candidate drivers */
  candidate_count: { type: Number },
  /** Details of scored and ranked drivers */
  top_drivers: { type: mongoose.Schema.Types.Mixed }
}, { _id: false });

/**
 * Vehicle photo structure used for pre-trip and post-trip checklists
 */
const VehiclePhotosSchema = new mongoose.Schema({
  /** URL for the vehicle front side photo */
  front: { type: String },
  /** URL for the vehicle rear side photo */
  rear: { type: String },
  /** URL for the vehicle left side photo */
  leftSide: { type: String },
  /** URL for the vehicle right side photo */
  rightSide: { type: String }
}, { _id: false });

/**
 * Harsh driving event schema
 */
const HarshDrivingEventSchema = new mongoose.Schema({
  /** Event description details */
  details: { type: String },
  /** Geographical coordinates of the event */
  location: {
    lat: { type: Number },
    lon: { type: Number }
  },
  /** ISO date string of when the event occurred */
  time: { type: String }
}, { _id: false });

const TripSchema = new mongoose.Schema({
  /** Unique identifier prefixing AD, region, date, and 6 random digits */
  rideId: {
    type: String,
    required: true,
    unique: true,
    index: true,
    match: /^AD[A-Z]{3}\d{12}$/
  },
  /** Flag denoting this is specifically an acting driver trip */
  isActingDriverTrip: {
    type: Boolean,
    required: true,
    default: true
  },
  /** Indicates if this is a future scheduled ride */
  isScheduledTrip: {
    type: Boolean,
    default: false
  },
  /** Schedule date and time in epoch milliseconds (required if isScheduledTrip is true) */
  scheduleDateTime: {
    type: Number,
    required: function() {
      return this.isScheduledTrip === true;
    }
  },
  /** Current state in matching/ride lifecycle */
  status: {
    type: String,
    required: true,
    enum: [
      "PENDING",
      "MATCHING",
      "ACCEPTED",
      "PICKEDUP",
      "DROPPED",
      "COMPLETED",
      "CANCELLED",
      "DIVERGED",
      "failed"
    ]
  },
  /** Required passenger vehicle type (e.g. "sedan", "suv") for driver suitability */
  vehicleType: {
    type: String,
    required: true
  },
  /** Reference to the passenger's registered Vehicle model */
  passangerVehicleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Vehicle"
  },
  /** Text description of passenger vehicle type */
  passangerVehicleType: {
    type: String
  },
  /** Reference to User model representing the passenger */
  passangerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  /** Normalized string representation of user identity */
  userId: {
    type: String,
    required: true
  },
  /** Identifier of the operator/system node that booked the trip */
  createdBy: {
    type: String,
    required: true
  },
  /** Type of booking, indicating if for self or third party */
  bookingFor: {
    type: String,
    enum: ["MYSELF", "SOMEONE_ELSE"]
  },
  /** Name of the passenger booking is created for */
  bookingForName: {
    type: String
  },
  /** Phone number of the passenger booking is created for */
  bookingForPhone: {
    type: String
  },
  /** Start location coordinates as [longitude, latitude] */
  startLocation: {
    type: [Number],
    required: true,
    validate: {
      validator: function(val) {
        return val.length === 2;
      },
      message: 'startLocation must contain exactly [longitude, latitude]'
    }
  },
  /** End location coordinates as [longitude, latitude] */
  endLocation: {
    type: [Number],
    required: true,
    validate: {
      validator: function(val) {
        return val.length === 2;
      },
      message: 'endLocation must contain exactly [longitude, latitude]'
    }
  },
  /** List of stops scheduled along the trip route */
  stops: [StopSchema],
  /** Count of passengers participating in the trip */
  passangerCount: {
    type: Number,
    default: 1
  },
  /** Estimated distance of trip (Number or String) */
  estimatedDistance: {
    type: mongoose.Schema.Types.Mixed
  },
  /** Estimated duration of trip in seconds/minutes */
  estimatedDuration: {
    type: Number
  },
  /** Minimum fare limit allowed for this ride */
  minFare: {
    type: Number
  },
  /** Maximum fare limit allowed for this ride */
  maxFare: {
    type: Number
  },
  /** Estimated base price computed for the route */
  estimatedFare: {
    type: Number
  },
  /** Adjusted surcharge or deduction applied to base price */
  fareAdjustment: {
    type: Number,
    default: 0
  },
  /** Actual final distance traveled */
  finalDistance: {
    type: mongoose.Schema.Types.Mixed
  },
  /** Actual final duration of ride */
  finalDuration: {
    type: Number
  },
  /** Method of settling trip invoice */
  paymentMethod: {
    type: String,
    enum: ["CASH", "ONLINE", "WALLET"]
  },
  /** Tracks whether the assigned driver received the payment */
  paymentReceivedByDriver: {
    type: Boolean,
    default: false
  },
  /** Identifies if booking qualifies for night-riding surcharges */
  nightRide: {
    type: Boolean,
    default: false
  },
  /** Request indicator restricting matching to female drivers */
  femaleOnly: {
    type: Boolean,
    default: false
  },
  /** Regional office handling oversight for the trip's operations */
  regionalOffice: {
    type: mongoose.Schema.Types.ObjectId
  },
  /** Country/region classification code (e.g. "CMR") */
  regionCode: {
    type: String
  },
  /** Driver model reference identifier assigned to complete the trip */
  driverId: {
    type: mongoose.Schema.Types.Mixed, // ObjectId or String
    ref: "Driver"
  },
  /** Epoch timestamp in floating seconds of when driver was assigned */
  assignedAt: {
    type: Number
  },
  /** Estimated time of arrival in minutes for the driver to pickup location */
  etaMinutes: {
    type: Number
  },
  /** Selection score details for the assigned driver */
  matchDetails: {
    score: { type: Number },
    eta: { type: Number },
    reasonCodes: [String]
  },
  /** System level decision codes recorded during matchmaking */
  reasonCodes: [String],
  /** Security OTP code required to start the trip */
  otp: {
    type: String
  },
  /** Historical transaction log of all matching events */
  rideMatchLog: [RideMatchLogSchema],
  /** Current matching iteration retry attempt (max 3) */
  matchAttempt: {
    type: Number,
    default: 0
  },
  /** Array of driver IDs excluded from being assigned this trip */
  excludedDriverIds: [String],
  /** Reason for final allocation failure */
  failureReason: {
    type: String
  },
  /** Party who canceled the ride */
  cancelledBy: {
    type: String,
    enum: ["DRIVER", "PASSENGER", "SYSTEM"]
  },
  /** Stated reason for cancelling the ride */
  cancelReason: {
    type: String
  },
  /** Epoch timestamp when cancellation occurred */
  cancelledAt: {
    type: Number
  },
  /** Location where the cancellation occurred */
  cancelledLoc: {
    lat: { type: Number },
    lon: { type: Number }
  },
  /** chronological timeline tracker of states */
  tripTimeline: [
    {
      state: { type: String },
      timestamp: { type: Number }
    }
  ],
  /** Encoded polyline path of the route */
  encodedPolyline: {
    type: String
  },
  /** Total driver wait time recorded */
  driverWaitTime: {
    type: Number
  },
  /** Passenger rating feedback of the driver */
  passengerRating: {
    rating: { type: Number },
    comment: { type: String }
  },
  /** Driver rating feedback of the passenger */
  driverRating: {
    rating: { type: Number },
    comment: { type: String }
  },
  /** Notification preferences for passenger updates */
  passengerNotificationPreferences: [
    {
      type: { type: String },
      name: { type: String },
      disabled: { type: Boolean }
    }
  ],
  /** Invoices, pre-trip and post-trip vehicle checklist documents */
  bills: {
    bills: [
      {
        billId: { type: String },
        description: { type: String },
        amount: { type: Number },
        receiptPhoto: { type: String },
        approval: { type: String, enum: ["pending", "approved", "rejected"] },
        paidAt: { type: Number },
        paymentReceiptPhoto: { type: String }
      }
    ],
    preTripVehiclePhotos: VehiclePhotosSchema,
    postTripVehiclePhotos: VehiclePhotosSchema
  },
  /** Telemetry monitoring logs for rough or unsafe driving patterns */
  harshDriving: {
    harshAcceleration: [HarshDrivingEventSchema],
    harshBreaking: [HarshDrivingEventSchema],
    harshCornering: [HarshDrivingEventSchema],
    overspeeding: [HarshDrivingEventSchema]
  },
  /** Maximum speed reached during the trip */
  maxSpeed: {
    type: Number
  },
  /** Holds details of accepted mid-ride stop changes */
  stopChangeRequest: {
    type: mongoose.Schema.Types.Mixed
  },
  /** Denotes whether it is a public rides trip */
  publicRidesTrip: {
    type: Boolean,
    default: true
  },
  /** Versioning representation of the matching workflow engine */
  rideMatchVersion: {
    type: String,
    default: "2.0"
  },
  /** Client application version string */
  appVersion: {
    type: String
  },
  /** Client application build number */
  buildNumber: {
    type: String
  },
  /** Booking epoch timestamp in milliseconds */
  bookingTime: {
    type: Number,
    required: true
  }
}, {
  timestamps: true, // auto adds createdAt and updatedAt as Dates
  collection: 'trips'
});

// Indexes
TripSchema.index({ status: 1, bookingTime: -1 });
TripSchema.index({ passangerId: 1, status: 1 });
TripSchema.index({ driverId: 1, status: 1 });
TripSchema.index({ regionalOffice: 1, status: 1 });

module.exports = mongoose.model('Trip', TripSchema);
