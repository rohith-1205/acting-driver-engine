# Technical Reverse-Engineering Report: Driver Matching & Routing Engine

**Target Codebase:** `acting-driver-engine`  
**Application Type:** Real-Time Acting Driver Matching, Scheduling, & Dispatching Engine  
**Primary Tech Stack:** Node.js (Express), MongoDB (Mongoose), Redis (ioredis), BullMQ, Socket.IO, Jest  

---

## 1. PROJECT OVERVIEW

### What Problem Does It Solve?
The `acting-driver-engine` solves the high-concurrency, low-latency problem of matching and dispatching **acting drivers** (drivers hired to operate a passenger's private vehicle) for both **immediate** and **future scheduled** rides. Unlike standard ride-hailing (where drivers use their own vehicles), acting driver dispatching requires evaluating vehicle handling experience, transmission compatibility, night driving authorization, long-distance capabilities, strict calendar schedule overlapping checks with geographic travel buffers, and multi-round fallback dispatching with distributed lock protection.

---

### Complete Request → Driver Matching → Dispatch Flow

```
[Passenger Request]
       │
       ▼
1. REST API Ingestion ──► POST /api/v2/trips/book (tripController.js)
       │                  - Saves Trip with status: "PENDING"
       │                  - Generates Ride ID: AD{REGION}{DDMMYY}{6-digit}
       ▼
2. Redis Scheduler ─────► ZADD scheduler:pending_trips <timestamp> <tripId>
       │
       ▼
3. Scheduler Worker ────► Polls due trips every 5s (schedulerWorker.js)
       │                  - Sets Redis matching_status: "in_progress"
       │                  - Updates MongoDB status: "MATCHING"
       │                  - Enqueues BullMQ Job to 'ad_matching' queue
       ▼
4. Matching Worker ─────► Executes candidate search (matchingWorker.js -> matchingService.js)
       │                  - Geo Search: Redis GEORADIUS 10km (driverLocationService.js)
       │                  - Excludes drivers in Redis SET trip:{id}:excluded_drivers
       │                  - Applies 10 Strict Filters (online, available, vehicle handling, calendar buffer)
       │                  - Multi-Factor Scoring (0-100 pts) -> Ranks & takes Top 5 candidates
       │                  - Saves Shortlist to Redis & Logs audit events to MongoDB
       ▼
5. Dispatch Worker ─────► Broadcasts alerts to candidate rooms (dispatchWorker.js)
       │                  - Socket.IO emit 'trip_request' to driver:room:{driverId}
       │                  - Enqueues delayed Timeout Verification Check Job (15,000ms)
       ▼
6. Driver Response ──────► Handled via WebSocket (handlers.js)
       ├──► ACCEPTS: Acquires Distributed Lock (SET trip:{id}:lock NX PX 60000)
       │             - Winner: MongoDB status -> "ACCEPTED", emits 'trip_assignment_confirmed'
       │             - Losers: Emits 'trip_request_withdrawn' (reason: TAKEN)
       │             - Enqueues Cleanup Job ('ad_cleanup')
       ├──► REJECTS: Records 'rejected' in Redis Hash, adds to Excluded SET.
       │             - If all candidates reject/timeout -> Triggers immediate next attempt
       └──► TIMEOUT: (timeoutWorker.js) Excludes non-responsive drivers.
                     - If Attempt < 3: Re-queues matching job for Attempt + 1
                     - If Attempt === 3: Marks MongoDB status -> "failed", enqueues Cleanup
```

---

## 2. ARCHITECTURE & COMPONENT MAP

### Main Components & Services

| Layer / Component | File Path | Key Responsibilities & Functions |
| :--- | :--- | :--- |
| **REST API Layer** | `src/app.js`<br>`src/api/routes/tripRoutes.js`<br>`src/api/controllers/tripController.js` | Express app initialization, route mounting (`/api/v2/trips/book`), payload validation, trip ID generation, and queueing to Redis scheduler. |
| **WebSocket Gateway** | `src/socket/gateway.js`<br>`src/socket/handlers.js` | Socket.IO server management, telemetry location ingestion (`driver_telemetry_ping`), presence tracking (`driver_register_presence`), and atomic acceptance/rejection event handlers (`driver_accept`, `driver_reject`). |
| **BullMQ Queue Infrastructure** | `src/queues/schedulerQueue.js`<br>`src/queues/matchingQueue.js`<br>`src/queues/dispatchQueue.js`<br>`src/queues/cleanupQueue.js` | Manages background queue definitions, default job retry backoffs, and typed job creation helpers. |
| **Background Workers** | `src/workers/schedulerWorker.js`<br>`src/workers/matchingWorker.js`<br>`src/workers/dispatchWorker.js`<br>`src/workers/timeoutWorker.js`<br>`src/workers/cleanupWorker.js` | Process asynchronous job execution: polling due trips, driver matching, notification dispatching, timeout expiration enforcement, and key cleanup. |
| **Redis State Service** | `src/services/redisStateService.js` | Low-latency state management: candidate shortlists, driver responses, excluded driver sets, attempt counters, scheduler sorted sets, and distributed locks (`acquireTripLock`). |
| **Matching Engine** | `src/services/matchingService.js` | Core matching algorithm: Haversine calculation, 10 eligibility filter evaluations, calendar conflict math with travel buffers, and multi-factor weighted scoring (`scoreDriver`). |
| **Driver Location Service** | `src/services/driverLocationService.js` | Spatial indexing operations: GEOADD/GEORADIUS operations for driver coordinates and metadata caching (`driver:{id}:meta`). |
| **Trip & Cancellation Services**| `src/services/tripService.js`<br>`src/services/cancellationService.js` | Mongoose MongoDB queries/updates, timeline logging, post-allocation driver cancellation processing, retry counting, and rematch triggering. |
| **Dispatch Service (Stub)** | `src/services/dispatchService.js` | **NOT IMPLEMENTED**: File exists with 2 comment lines; actual dispatch logic lives in `workers/dispatchWorker.js` and `socket/gateway.js`. |
| **Driver Controller (Stub)**| `src/api/controllers/driverController.js` | **NOT IMPLEMENTED**: File exports an empty object (`module.exports = {}`); no HTTP REST endpoints exist for driver CRUD. |
| **Driver Routes (Stub)** | `src/api/routes/driverRoutes.js` | **NOT IMPLEMENTED**: Route definition file exists but mounts no endpoints. |

---

### Component Communication Diagram

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                       CLIENTS                                          │
│   (Passenger Mobile App)                              (Driver Mobile Apps / Devices)   │
└───────────┬──────────────────────────────────────────────────────▲─────────────────────┘
            │ POST /api/v2/trips/book                              │ WebSocket (Socket.IO)
            ▼                                                      ▼
┌───────────────────────┐                               ┌────────────────────────────────┐
│   Express REST API    │                               │       Socket.IO Gateway        │
│  (tripController.js)  │                               │    (gateway.js / handlers.js)  │
└───────────┬───────────┘                               └──────────────┬─────────────────┘
            │                                                          │
            │ ZADD scheduler:pending_trips                             │ acquireTripLock()
            ▼                                                          │ recordDriverResponse()
┌───────────────────────┐   ZRANGEBYSCORE   ┌────────────────────────┐ │
│  Redis In-Memory Data │◄──────────────────┤    Scheduler Worker    │ │
│   (redisStateService) │                   │  (schedulerWorker.js)  │ │
└───────────▲───────────┘                   └───────────┬────────────┘ │
            │                                           │              │
            │ GEORADIUS / SET / HSET                    │ addMatchingJob()
            │                                           ▼              │
            │                               ┌────────────────────────┐ │
            ├───────────────────────────────┤    Matching Worker     │ │
            │                               │   (matchingWorker.js)  │ │
            │                               └───────────┬────────────┘ │
            │                                           │              │
            │                                           │ addDispatchJob()
            │                                           ▼              │
            │                               ┌────────────────────────┐ │
            ├───────────────────────────────┤    Dispatch Worker     ├─┘
            │                               │   (dispatchWorker.js)  │
            │                               └────────────────────────┘
            ▼
┌───────────────────────┐
│ MongoDB (Persistent)  │  - System of Record: drivers, trips, vehicles
│     (Mongoose)        │  - Stores full audit logs (rideMatchLog, tripTimeline)
└───────────────────────┘
```

---

## 3. DRIVER MATCHING ALGORITHM

The driver selection engine is implemented in `src/services/matchingService.js` (entry point: `findEligibleDrivers`).

### 1. Spatial Discovery
- **Function:** `findNearbyDrivers` in `src/services/driverLocationService.js`
- **Execution:** Runs `GEORADIUS geo:acting_drivers:{REGIONCODE} <lon> <lat> 10 km ASC WITHDIST COUNT 50`.
- **Result:** Returns up to 50 drivers within 10 km sorted by distance.

---

### 2. Candidate Filtering Pipeline (10 Sequential Filters)

Every candidate driver fetched from MongoDB is evaluated against 10 strict filter checks in `matchingService.js` (lines 253–365):

1. **Exclusion Check:** Driver ID must not exist in Redis SET `trip:{id}:excluded_drivers` (holds drivers who rejected, timed out, or cancelled).
2. **Approval Check (`isApproved`):** `driver.isApproved === true`.
3. **Availability Flag (`isAvailable`):** `driver.isAvailable === true`.
4. **Administrative Block (`isBlocked`):** `driver.isBlocked !== true`.
5. **Soft Deletion Marker (`isDeleted`):** `driver.isDeleted !== true`.
6. **Online Connection State (`driverStatus.status`):** `driver.driverStatus.status === 'online'`.
7. **Occupancy Status (`tripStatus`):** `driver.tripStatus === 'NOTRIP'`.
8. **Acting Driver Role/Mode:** `driver.role === 'acting_driver'` OR `driver.mode.includes('acting_driver')`.
9. **Vehicle Type Experience:** `driver.experience.vehicleTypes` (Array) must include `trip.vehicleType` (e.g., `"sedan"`, `"suv"`).
10. **Redis Active Trip Verification:** Checks Redis hash `driver:{id}:meta`. `tripStatus` in Redis must not be `'ONTRIP'`.
11. **Calendar Schedule Conflict & Buffer Check (Scheduled Trips Only):**
    For scheduled trips (`trip.isScheduledTrip === true`), the engine queries all upcoming trips for the driver (`upComingTrips`) with status `PENDING`, `ACCEPTED`, or `MATCHING`.
    - **Formula:**  
      $$\text{TravelTimeMs} = \left( \frac{\text{HaversineDistance(ExistingDropOff, NewPickup)}}{\text{AVERAGE\_SPEED\_KMPH}} \right) \times 3,600,000$$
      $$\text{EffectiveBufferMs} = \text{clamp}(\text{driver.calendarBufferMinutes}, \text{PLATFORM\_MIN\_BUFFER}, \text{MAX\_BUFFER})$$
      $$\text{ExistingTripEndMs} = \text{ScheduleDateTime} + \text{EstimatedDurationMs} + \text{TravelTimeMs} + \text{EffectiveBufferMs}$$
    - **Rule:** If $\text{ExistingTripEndMs} > \text{newTrip.scheduleDateTime}$, driver is **excluded** due to schedule conflict.

---

### 3. Multi-Factor Driver Scoring Algorithm (`scoreDriver`)

Scoring evaluates remaining eligible drivers on a 0–100 scale using weighted configuration parameters from `src/config/env.js`:

$$\text{Total Score} = \sum \text{Points}_i \quad (\text{clamped between } 0 \text{ and } 100)$$

| Dimension | Calculation Logic | Config Weight Variable (Default) |
| :--- | :--- | :--- |
| **Distance** | $\le 2\text{km}: 1.0 \mid \le 5\text{km}: 0.75 \mid \le 8\text{km}: 0.50 \mid \le 10\text{km}: 0.25 \mid > 10\text{km}: 0.0$ | `SCORE_WEIGHT_DISTANCE` (30) |
| **Rating** | $\ge 4.5: 1.0 \mid \ge 4.0: 0.75 \mid \ge 3.5: 0.50 \mid < 3.5: 0.0$ (Missing rating defaults to $0.75$) | `SCORE_WEIGHT_RATING` (20) |
| **Vehicle Match** | `driver.experience.vehicleHandling.includes(trip.vehicleType) ? 1.0 : 0.0` | `SCORE_WEIGHT_VEHICLE_MATCH` (15) |
| **Experience Tenure** | `totalExperience` in `["3+", "5+"]`: $1.0 \mid$ `"1-3"`: $0.5 \mid$ else: $0.0$ | `SCORE_WEIGHT_EXPERIENCE` (10) |
| **Night Driving** | If `trip.nightRide === true`: `driver.experience.nightDriving === true ? 1.0 : 0.0` | `SCORE_WEIGHT_NIGHT_DRIVING` (10) |
| **Long Distance** | If `trip.estimatedDistance > 50`: `driver.experience.longDistance === true ? 1.0 : 0.0` | `SCORE_WEIGHT_LONG_DISTANCE` (5) |
| **Acceptance Rate** | $\text{Ratio} = \frac{\text{Accepted}}{\text{Accepted} + \text{Rejected}} \implies \ge 0.5: 1.0 \mid \ge 0.3: 0.5 \mid < 0.3: 0.0$ (No trips: $1.0$) | `SCORE_WEIGHT_ACCEPTANCE_RATE` (10) |

---

### 4. Ranking & Shortlisting
- Candidates are sorted by score descending.
- Top `SHORTLIST_SIZE` (default **5**) drivers are selected.
- Estimated Time of Arrival (ETA) is computed per shortlisted driver:  
  $$\text{ETA (mins)} = \text{clamp}\left(\left\lceil \frac{\text{distanceKm}}{20} \times 60 \right\rceil, 1, 30\right)$$
- Audit logs (`available_drivers` and `ranked_drivers` with reason codes) are appended to MongoDB `trip.rideMatchLog`.

---

## 4. REDIS ARCHITECTURE & DATA STRUCTURES

Redis (`src/config/redis.js`, `src/services/redisStateService.js`, `src/services/driverLocationService.js`) serves as the ultra-fast state store.

### Redis Keys & Data Structures Summary

| Key Pattern | Redis Data Structure | TTL / Expiry | Purpose & Usage |
| :--- | :--- | :--- | :--- |
| `geo:acting_drivers:{REGIONCODE}` | **GEO (ZSET)** | No TTL | Spatial index of online drivers. Added via `GEOADD`, queried via `GEORADIUS`. |
| `driver:{driverId}:meta` | **HASH** | 3600s (1 hr) | Cached driver metadata (`regionCode`, `isOnline`, `tripStatus`, `lastSeen`). |
| `scheduler:pending_trips` | **ZSET** | No TTL | Priority queue / timer wheel for due trips. Score = epoch ms. Queried via `ZRANGEBYSCORE`. |
| `trip:{tripId}:status` | **STRING** | 3600s (1 hr) | General trip lifecycle status string. |
| `trip:{tripId}:matching_status` | **STRING** | 3600s (1 hr) | Tracking matching state: `"in_progress"`, `"allocated"`, `"failed"`. Prevents duplicate matching runs. |
| `trip:{tripId}:shortlist` | **STRING** (JSON) | 300s (5 min) | Shortlisted candidate driver IDs array `["id1", "id2", ...]`. |
| `trip:{tripId}:responses` | **HASH** | 300s (5 min) | Hash mapping `driverId` $\rightarrow$ response (`"accepted"`, `"rejected"`, `"timeout"`). |
| `trip:{tripId}:lock` | **STRING** | 60000ms (60s) | Distributed lock acquired via `SET NX PX 60000` during driver acceptance to prevent double allocation. |
| `trip:{tripId}:attempt` | **STRING** | 3600s (1 hr) | Integer string tracking current matching attempt round (1, 2, or 3). |
| `trip:{tripId}:excluded_drivers` | **SET** | 3600s (1 hr) | Set of driver IDs excluded from current/future match attempts. Added via `SADD`. |
| `driver:{driverId}:active_trip` | **STRING** | 86400s (24 hr)| Active allocated trip ID associated with a driver. |

---

### Why Redis is Used Here
1. **Microsecond Latency:** Spatial indexing via `GEORADIUS` runs in sub-millisecond time.
2. **Concurrency Control:** Atomic operations (`SET NX` distributed lock, `multi()` pipelines) prevent race conditions.
3. **Timer Wheel Scheduling:** Redis Sorted Sets (`ZSET`) allow efficient $O(\log N)$ extraction of due scheduled rides without scanning MongoDB.
4. **Decoupling State from DB:** Transient negotiation states (responses, shortlists, locks) are kept out of disk-bound databases.

---

## 5. BULLMQ QUEUE INFRASTRUCTURE

The queue subsystem (`src/queues/` and `src/workers/`) handles asynchronous processing with isolated Redis connections.

```
                  ┌──────────────────────────────────────────────────────────┐
                  │                    BULLMQ QUEUES                         │
                  └──────────────────────────────────────────────────────────┘
                                               │
           ┌──────────────────────┬────────────┴─────────────┬──────────────────────┐
           ▼                      ▼                          ▼                      ▼
┌────────────────────┐  ┌────────────────────┐     ┌────────────────────┐  ┌────────────────────┐
│    ad_scheduler    │  │    ad_matching     │     │    ad_dispatch     │  │     ad_cleanup     │
│ (schedulerQueue.js)│  │ (matchingQueue.js) │     │ (dispatchQueue.js) │  │ (cleanupQueue.js)  │
└──────────┬─────────┘  └─────────┬──────────┘     └─────────┬──────────┘  └─────────┬──────────┘
           │                      │                          │                      │
           ▼                      ▼                          ▼                      ▼
┌────────────────────┐  ┌────────────────────┐     ┌────────────────────┐  ┌────────────────────┐
│  schedulerWorker   │  │   matchingWorker   │     │   dispatchWorker   │  │   cleanupWorker    │
│ (concurrency: 1)   │  │  (concurrency: 5)  │     │ (concurrency: 10)  │  │  (concurrency: 5)  │
└────────────────────┘  └─────────┬──────────┘     └────────────────────┘  └────────────────────┘
                                  │
                                  ▼ (isTimeoutCheck: true)
                        ┌────────────────────┐
                        │   timeoutWorker    │
                        │ (timeoutWorker.js) │
                        └────────────────────┘
```

### Queue Configurations & Job Flow

| Queue Name | Queue Key Variable | Concurrency | Job Name | Retry Strategy | Purpose & Flow |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Scheduler Queue** | `ad_scheduler` | 1 | `poll_due_trips` | 3 attempts, exponential 2s | Repeatable job firing every 5000ms. Queries due trips in Redis ZSET and enqueues matching jobs. |
| **Matching Queue** | `ad_matching` | 5 | `matching_job` | 3 attempts, exponential 2s | Executes candidate discovery and scoring. Also handles delayed timeout checks (`isTimeoutCheck: true`). |
| **Dispatch Queue** | `ad_dispatch` | 10 | `dispatch_job` | 3 attempts, exponential 2s | Broadcasts WebSocket `trip_request` alerts to shortlisted drivers and schedules delayed timeout checks. |
| **Cleanup Queue** | `ad_cleanup` | 5 | `cleanup_job` | 3 attempts, exponential 2s | Runs pipeline deletion of transient Redis keys after trip completion, failure, or cancellation. |

---

## 6. MONGODB & SOCKET.IO INFRASTRUCTURE

### MongoDB Schemas (`src/models/`)
MongoDB is the persistent system of record.

1. **`Trip.js` (`trips` collection):**
   - **Indexed Fields:** `{ rideId: 1 }` (unique regex `^AD[A-Z]{3}\d{12}$`), `{ status: 1, bookingTime: -1 }`, `{ passangerId: 1, status: 1 }`, `{ driverId: 1, status: 1 }`, `{ regionalOffice: 1, status: 1 }`.
   - **Key Sub-documents:**
     - `stops`: Nested stops with coordinate validation `[longitude, latitude]`.
     - `rideMatchLog`: Full chronological audit array recording every matching event (`trip_request_attempt`, `socket_message_sent`, `driver_trip_response`, `trip_allocated`, `match_failed`, `rematch_triggered`).
     - `tripTimeline`: Lifecycle state transition log.
     - `bills`: Vehicle inspection photos (`preTripVehiclePhotos`, `postTripVehiclePhotos`) and receipts.
     - `harshDriving`: Telemetry log for rough acceleration, braking, cornering, overspeeding.

2. **`Driver.js` (`drivers` collection):**
   - **Indexed Fields:** `location: "2dsphere"`, `{ isActingDriver: 1, isApproved: 1, isAvailable: 1 }`, `{ "driverStatus.status": 1 }`, `regionalOffice: 1`, `tripStatus: 1`.
   - **Key Fields:** `experience` (vehicle types, transmission, long distance, night driving), `upComingTrips` (array of assigned trip ObjectIds), `calendarBufferMinutes` (default 120 mins).

3. **`Vehicle.js` (`vehicles` collection):**
   - Stores passenger vehicle models (`make`, `model`, `year`, `transmission`, `fuelType`, `registrationNumber`). Indexed on `{ ownerId: 1, isActive: 1 }`.

---

### Socket.IO Real-Time Gateway (`src/socket/gateway.js`, `src/socket/handlers.js`)

- **Server Setup:** Socket.IO v4 attached to Express HTTP server or port `4001` with CORS `*`.
- **Room Taxonomy:**
  - `driver:room:{driverId}`: Private room per driver for targeted trip request dispatches and assignment confirmations.
  - `region:room:{regionCode}`: Regional channel for broadcast updates.

#### WebSocket Event Matrix

| Event Name | Direction | Payload | Trigger / Handler | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `join_driver_room` | Client $\rightarrow$ Server | `{ driverId }` | `gateway.js` | Joins socket to `driver:room:{driverId}`. |
| `driver_register_presence` | Client $\rightarrow$ Server | `{ driverId, regionCode }` | `gateway.js` | Registers presence, sets `socket.driverId` & `socket.regionCode`. |
| `driver_telemetry_ping` | Client $\rightarrow$ Server | `{ longitude, latitude }` | `gateway.js` | Updates location in Redis GEO set & metadata hash. |
| `trip_request` | Server $\rightarrow$ Client | `{ tripId, fare, currency, attempt, timeoutMs }` | `dispatchWorker.js` | Broadcasts new trip offer to shortlisted driver rooms. |
| `driver_accept` | Client $\rightarrow$ Server | `{ tripId, driverId }` | `handlers.js` | Triggers atomic lock challenge and trip assignment. |
| `driver_reject` | Client $\rightarrow$ Server | `{ tripId, driverId }` | `handlers.js` | Records rejection in Redis. Triggers immediate rematch if all responded. |
| `trip_assignment_confirmed` | Server $\rightarrow$ Client | `{ tripId }` | `handlers.js` | Emitted to winning driver upon successful DB allocation. |
| `trip_request_withdrawn` | Server $\rightarrow$ Client | `{ tripId, reason: "TAKEN" }` | `handlers.js` | Emitted to losing shortlisted drivers when another driver accepts. |
| `trip_error` | Server $\rightarrow$ Client | `{ reason }` | `handlers.js` | Emitted on lock failure (`ORDER_TAKEN`), allocation conflict (`TRIP_ALLOCATED_ALREADY`), or server errors. |
| `disconnect` | Event | None | `gateway.js` | Flags driver `driverStatus.status = "offline"` in MongoDB. |

---

## 7. CONCURRENCY, FAULT TOLERANCE & RACE CONDITIONS

### 1. Duplicate Driver Assignment (Race Condition)
- **Problem:** Two drivers receive a `trip_request` simultaneously and tap "Accept" at the exact same millisecond.
- **Solution:** Implemented in `src/socket/handlers.js` via `redisStateService.acquireTripLock`:
  ```js
  const lockAcquired = await redisStateService.acquireTripLock(tripId, driverId);
  // Executes: SET trip:{tripId}:lock driverId PX 60000 NX
  ```
  - **Winner:** Only one socket operation returns `OK` (`lockAcquired === true`). It verifies `matching_status !== 'allocated'`, updates Redis matching status to `'allocated'`, and executes an atomic MongoDB update:
    ```js
    Trip.findOneAndUpdate({ _id: tripId, status: "MATCHING" }, { $set: { status: "ACCEPTED", driverId } })
    ```
  - **Losing Driver:** Receives `lockAcquired === false`. The handler immediately emits `trip_error` with `{ reason: "ORDER_TAKEN" }`.

---

### 2. Post-Allocation Driver Cancellation & Rematch Thresholds
- **File:** `src/services/cancellationService.js` (`handleDriverCancellation`)
- **Flow:** When a driver cancels an accepted ride before pickup:
  1. Counts prior `CANCELLED_BY_DRIVER_BEFORE_PICKUP` entries in `tripTimeline`.
  2. **If Cancellation Count $< 3$:**
     - Clears driver active trip mapping in Redis (`clearDriverActiveTrip`).
     - Updates MongoDB trip status back to `"MATCHING"`.
     - Appends cancelling driver to Redis SET `trip:{id}:excluded_drivers`.
     - Re-enqueues job to `ad_matching` queue for Attempt 1 with **high priority** (`priority: 1`).
  3. **If Cancellation Count $\ge 3$:**
     - Exceeds `MAX_CANCELLATION_RETRIES` (3).
     - Marks MongoDB trip status as `"failed"` with `failureReason: "MaxRetriesExceeded"`.
     - Enqueues cleanup job to `ad_cleanup`.

---

### 3. Database & Redis Connection Fault Resilience
- **MongoDB Connection:** `src/config/db.js` wraps `mongoose.connect` in `connectWithRetry`, attempting up to 5 connections with a 5000ms delay before throwing.
- **Redis Connection:** `src/config/redis.js` sets `maxRetriesPerRequest: null` (required by BullMQ to prevent queue worker crashes on transient network blips).
- **Graceful Shutdown:** `src/app.js` catches `SIGINT` and `SIGTERM`, sequentially closing workers (`schedulerWorker`, `matchingWorker`, `timeoutWorker`, `cleanupWorker`, `dispatchWorker`), closing Redis (`redisClient.quit()`), and stopping HTTP servers.

---

## 8. PERFORMANCE & SCALABILITY ANALYSIS

### Why the System achieves Low Latency / High Throughput
1. **Sub-5ms Driver Lookup:** Uses Redis GEO spatial indexing rather than querying MongoDB $2\text{dsphere}$ indexes on every tick.
2. **Decoupled Asynchronous Workers:** Heavy scoring algorithms and socket broadcasting are offloaded from the Express HTTP event loop into background BullMQ workers.
3. **Lock-Free Non-Blocking Ingestion:** Trip creation (`bookTrip`) only writes to MongoDB and pushes to a Redis ZSET, returning an immediate HTTP `211` response.
4. **Early Exit Rejection Handling:** When all shortlisted drivers reject/timeout early, `handlers.js` bypasses the 15-second timer delay and instantly triggers the next matching attempt.

---

### System Bottlenecks & Limitations in Current Code

1. **MongoDB Query Overhead in Matching Step:** `matchingService.js` calls `Driver.find({ _id: { $in: candidateIds } })` to fetch complete driver Mongoose documents. Under high load (thousands of candidates), fetching full Mongoose documents incurs overhead compared to Redis hashing.
2. **Sequential Scheduled Calendar Check:** The calendar buffer check queries upcoming trips sequentially per candidate.
3. **Single Node Socket.IO Limits:** `src/socket/gateway.js` uses an in-memory Socket.IO instance. Without a Socket.IO Redis Adapter (`@socket.io/redis-adapter`), real-time socket connections cannot be horizontally scaled across multiple app instances.
4. **Fixed Scheduler Poll Batch Size:** `schedulerWorker.js` queries `limit = 50` due trips per 5-second interval. Under massive surge volume (>1,000 scheduled trips per minute), the poll interval could bottleneck.

---

### Recommended Scalability Enhancements
- **Socket.IO Redis Adapter:** Introduce `@socket.io/redis-adapter` to allow multiple gateway instances to broadcast alerts to driver rooms.
- **Cache Driver Profiles in Redis HASH:** Move driver experience and rating data into Redis hashes to eliminate MongoDB queries during candidate filtering.
- **Dynamic Scheduler Polling:** Transition from 5s polling to BullMQ Delayed Jobs per scheduled trip (`queue.add('job', data, { delay: scheduleDateTime - now - 15mins })`).

---

## 9. TESTING ANALYSIS

### Test Suite Structure (`tests/`)
The repository contains 4 unit test files using Jest with mock dependencies (`jest.mock`):

```
tests/
├── matchingService.test.js    (11 unit tests - eligibility filters, scoring, ranking, calendar conflict math)
├── cancellationService.test.js (6 unit tests - cancellation limits, timeoutWorker, cleanupWorker)
├── dispatchWorker.test.js      (2 unit tests - 5-driver broadcast, simultaneous accept race condition test)
└── gateway.test.js             (7 unit tests - REST ingestion validation, Socket presence, telemetry ping, disconnect)
```

---

### Critical Edge Cases Covered in Tests
- **Score Validation:** Tests perfect drivers (score $\ge 90$) vs poor rating/high distance drivers (score $\le 40$).
- **Eligibility Filters:** Tests filtering of offline drivers, ONTRIP drivers, mismatched vehicle types, and excluded drivers.
- **Calendar Conflict Travel Buffer Math:** Tests scheduled trip eligibility when existing trip drop-off location requires travel time to new pickup location plus buffer.
- **Race Condition Resolution:** Simulates simultaneous `driver_accept` calls from two driver sockets, asserting that exactly one acquires the lock, receives assignment, and the loser gets `ORDER_TAKEN`.
- **Cancellation Threshold Enforcement:** Verifies that $<3$ cancellations trigger a rematch with priority 1, while $\ge 3$ cancellations mark the trip as failed.

---

### Missing / Non-Existent Tests & Functionality
- **NO Real Database/Redis Integration Tests:** All tests use `jest.mock()`. There are no live containerized integration tests (e.g., using Testcontainers).
- **NO Postman Collection / E2E Automation:** No Postman JSON collections exist in the repository.
- **NO Stress / Load Performance Benchmarks:** No k6 or Artillery load tests exist.

---

## 10. INTERVIEW PREPARATION GUIDE

### A 2-Minute Elevator Pitch of the Project

> "I built an **Acting Driver Matching & Scheduling Engine** designed to solve real-time driver dispatching for passengers who need professional drivers to operate their private vehicles. 
> 
> Unlike standard ride-hailing, acting driver dispatch requires multi-dimensional matching—we evaluate vehicle handling experience, transmission types, long-distance capabilities, night-driving flags, and complex calendar schedule overlaps with geographic travel buffers.
> 
> Architecturally, the engine uses **Express** for REST ingestion, **MongoDB** as the system of record, **Redis** for sub-millisecond spatial lookups (`GEORADIUS`), distributed locks (`SET NX PX`), and timer-wheel scheduling (`ZSET`). We use **BullMQ** to orchestrate asynchronous background queues for scheduler polling, multi-factor scoring, WebSocket alerts, and key cleanup.
> 
> To handle high concurrency, real-time messaging is handled via **Socket.IO** rooms. We solve race conditions when multiple drivers tap 'Accept' simultaneously by executing atomic Redis challenge locks before mutating MongoDB state, ensuring zero duplicate assignments. The codebase is thoroughly covered with **Jest** unit tests validating edge cases like calendar conflict travel math and simultaneous driver accept races."

---

### Key Classes, Functions & Files You MUST Know

1. **`src/services/matchingService.js` $\rightarrow$ `findEligibleDrivers(trip, attempt)`**  
   *Core algorithm.* Performs Redis GEORADIUS search, applies 10 eligibility filters, calculates calendar travel buffers, runs `scoreDriver`, and returns top 5 shortlisted candidates.
2. **`src/services/matchingService.js` $\rightarrow$ `scoreDriver(driver, distanceKm, trip)`**  
   *Scoring logic.* Calculates weighted score (0–100) based on distance, rating, vehicle match, experience, night driving, long distance, and acceptance rates.
3. **`src/socket/handlers.js` $\rightarrow$ `driver_accept` event handler**  
   *Race condition guard.* Executes atomic `acquireTripLock`, checks matching status, updates MongoDB trip to `ACCEPTED`, emits `trip_assignment_confirmed` to winner and `trip_request_withdrawn` to losing candidates.
4. **`src/services/redisStateService.js` $\rightarrow$ `acquireTripLock(tripId, driverId)`**  
   *Distributed lock.* Calls `redis.set('trip:{id}:lock', driverId, 'PX', 60000, 'NX')`.
5. **`src/workers/schedulerWorker.js` $\rightarrow$ `schedulerWorker`**  
   *Scheduler worker.* Polls due trips from Redis ZSET (`scheduler:pending_trips`), updates status, and enqueues jobs to BullMQ `ad_matching` queue.
6. **`src/services/cancellationService.js` $\rightarrow$ `handleDriverCancellation(tripId, driverId, cancelReason)`**  
   *Cancellation recovery.* Checks prior cancellation count; if $< 3$, resets state to `MATCHING`, excludes driver, and triggers high-priority rematch.
7. **`src/utils/rideIdGenerator.js` $\rightarrow$ `generateActingDriverRideId(regionCode)`**  
   *Identifier generator.* Formats ride IDs as `AD{REGION}{DDMMYY}{6-digit-random}` (e.g., `ADCMR240826123456`).

---

### 20 Likely Technical Interview Questions & Code-Specific Answers

#### Q1: What happens end-to-end when a passenger books a trip?
**Answer:** The request hits `POST /api/v2/trips/book` (`src/api/controllers/tripController.js`: `bookTrip`). It validates payload coordinates, generates a ride ID formatted like `ADCMR240826123456` via `generateActingDriverRideId`, creates a MongoDB `Trip` with status `"PENDING"`, adds the trip ID to Redis ZSET `scheduler:pending_trips` with score = scheduled time (or `Date.now()` for immediate trips), and returns HTTP status `211`.

#### Q2: How are immediate vs scheduled trips handled differently?
**Answer:** Both enter the same Redis ZSET `scheduler:pending_trips`. Immediate trips are added with `score = Date.now()`, making them immediately eligible for the scheduler poll. Scheduled trips are added with `score = scheduleDateTime`. The `schedulerWorker` polls `ZRANGEBYSCORE` for scores $\le \text{Date.now()}$, seamlessly picking up both immediate and due scheduled trips without separate cron implementations.

#### Q3: How does the system prevent two drivers from being assigned the same trip if they click accept simultaneously?
**Answer:** In `src/socket/handlers.js`, the `driver_accept` handler calls `redisStateService.acquireTripLock(tripId, driverId)`, executing `SET trip:{id}:lock driverId PX 60000 NX`. Redis single-threaded execution guarantees only one driver gets `OK`. The winner updates matching status to `'allocated'` and executes `Trip.findOneAndUpdate({ _id: tripId, status: "MATCHING" }, { status: "ACCEPTED" })`. The losing driver receives `lockAcquired === false` and gets a Socket event `trip_error` with reason `"ORDER_TAKEN"`.

#### Q4: What Redis data structures are used and why?
**Answer:**
- **ZSET (`scheduler:pending_trips`):** Priority queue for due scheduled trips.
- **GEO ZSET (`geo:acting_drivers:{REGION}`):** Spatial indexing for `GEORADIUS` spatial queries.
- **STRING (`trip:{id}:lock` with `NX`):** Distributed lock.
- **HASH (`driver:{id}:meta` & `trip:{id}:responses`):** Fast key-value lookups for status and responses.
- **SET (`trip:{id}:excluded_drivers`):** Unique collection of rejected/timed-out driver IDs.

#### Q5: How is a driver's location updated in real-time?
**Answer:** Driver apps send `driver_telemetry_ping` over Socket.IO with `{ longitude, latitude }`. `src/socket/gateway.js` delegates to `src/services/driverLocationService.js`: `upsertDriverLocation`, which executes a Redis `multi()` pipeline calling `GEOADD geo:acting_drivers:{REGION} lon lat driverId` and updates the metadata hash `driver:{driverId}:meta` with `isOnline: 1` and `lastSeen`.

#### Q6: How does the driver scoring algorithm work?
**Answer:** `scoreDriver` in `src/services/matchingService.js` computes a weighted score (0–100) combining 7 factors: Distance (30%), Rating (20%), Vehicle Handling Match (15%), Experience Tenure (10%), Night Driving (10%), Long Distance (5%), and Acceptance Rate (10%). Candidate scores are sorted descending, and the top 5 are shortlisted.

#### Q7: How does the system handle scheduled trip calendar conflicts?
**Answer:** In `matchingService.js` (lines 318–361), for scheduled trips, it queries candidate drivers' `upComingTrips`. For each existing trip, it calculates drop-off location to new trip pickup location distance using Haversine, estimates travel time based on `AVERAGE_SPEED_KMPH`, adds driver calendar buffer minutes, and calculates `existingTripEnd`. If `existingTripEnd > newTrip.scheduleDateTime`, the driver is excluded.

#### Q8: What queues exist in BullMQ and what are their concurrency settings?
**Answer:**
- `ad_scheduler` (concurrency: 1) — Polls due trips.
- `ad_matching` (concurrency: 5) — Executes matching and timeout checks.
- `ad_dispatch` (concurrency: 10) — Emits WebSocket notifications.
- `ad_cleanup` (concurrency: 5) — Wipes Redis keys.

#### Q9: What happens if a shortlisted driver does not respond to a trip request within 15 seconds?
**Answer:** `dispatchWorker.js` enqueues a delayed job to `ad_matching` with `{ isTimeoutCheck: true }` and `delay: 15000`. When `timeoutWorker.js` executes `handleTimeoutCheck`, it verifies if the trip is already allocated. If not, it records response `'timeout'` in Redis, adds the driver to `trip:{id}:excluded_drivers`, appends a timeout event to MongoDB `rideMatchLog`, and enqueues the next matching attempt (`attempt + 1`).

#### Q10: What happens if a driver accepts a trip but then cancels before pickup?
**Answer:** `src/services/cancellationService.js`: `handleDriverCancellation` counts prior `CANCELLED_BY_DRIVER_BEFORE_PICKUP` entries in `tripTimeline`. If count $< 3$, it clears active trip state in Redis, updates MongoDB status back to `"MATCHING"`, adds the driver to the Redis exclusion set, and re-queues a matching job with **high priority** (`priority: 1`). If count $\ge 3$, it fails the trip with `MaxRetriesExceeded`.

#### Q11: How does the engine handle early re-matching when all shortlisted drivers reject?
**Answer:** In `src/socket/handlers.js`, when a driver emits `driver_reject`, the handler updates Redis responses and checks if `shortlist.every(id => responses[id] === 'rejected' || responses[id] === 'timeout')`. If all candidates have responded, it bypasses the 15-second timeout delay and immediately pushes the next attempt job to `ad_matching`.

#### Q12: What MongoDB models and indexes are defined?
**Answer:**
- `Driver`: `2dsphere` spatial index on `location`, compound index on `{ isActingDriver: 1, isApproved: 1, isAvailable: 1 }`.
- `Trip`: Unique index on `rideId`, compound indexes on `{ status: 1, bookingTime: -1 }`, `{ passangerId: 1, status: 1 }`, `{ driverId: 1, status: 1 }`.
- `Vehicle`: Index on `{ ownerId: 1, isActive: 1 }`.

#### Q13: What happens when all 3 matching attempt rounds fail to find a driver?
**Answer:** When attempt 3 times out or finds zero eligible drivers, `matchingWorker.js` or `timeoutWorker.js` calls `tripService.markTripAsFailed(tripId, "NoAvailableDrivers")`, appends `match_failed` event to MongoDB `rideMatchLog`, and enqueues `cleanup_job` to `ad_cleanup`.

#### Q14: How are transient Redis keys cleaned up after a trip finishes matching?
**Answer:** `cleanupWorker.js` receives `cleanup_job` (reason: `allocated`, `failed`, or `cancelled`) and calls `redisStateService.cleanupAllTripKeys(tripId)`. This uses a Redis `pipeline()` to execute `DEL` on `status`, `shortlist`, `responses`, `lock`, `attempt`, `excluded_drivers`, and `matching_status`.

#### Q15: Why is `dispatchService.js` empty / stubbed out?
**Answer:** `dispatchService.js` is **NOT IMPLEMENTED** (contains only 2 comment lines). Dispatching is handled directly by `src/workers/dispatchWorker.js` calling Socket.IO `io.to('driver:room:' + driverId).emit('trip_request', payload)` via `src/socket/gateway.js`.

#### Q16: Why does `bookTrip` return HTTP status 211?
**Answer:** In `src/api/controllers/tripController.js` (line 80), `bookTrip` explicitly returns `res.status(211).json(...)`. This is a non-standard HTTP status code specified by custom API protocol requirements for ride ingestion acceptance.

#### Q17: How is driver disconnect handled over WebSockets?
**Answer:** In `src/socket/gateway.js`, the `disconnect` event handler reads `socket.driverId`. If present, it updates MongoDB `Driver.updateOne({ _id: socket.driverId }, { $set: { "driverStatus.status": "offline", "driverStatus.updatedOn": Date.now() } })`, marking the driver offline while preserving their last known GEO location in Redis.

#### Q18: What environment configuration variables are mandatory?
**Answer:** `src/config/env.js` validates 26 required variables on boot (e.g., `MONGO_URI`, `REDIS_HOST`, `SCHEDULER_QUEUE_NAME`, `MAX_MATCH_ATTEMPTS`, `DRIVER_RESPONSE_TIMEOUT_MS`, `SCORE_WEIGHT_DISTANCE`). Missing any variable throws an explicit error and halts engine startup.

#### Q19: How are audit logs stored for debugging matching decisions?
**Answer:** Every trip document in MongoDB contains a `rideMatchLog` array. `matchingService.js` appends `available_drivers` (raw count and driver snapshots), `ranked_drivers` (top candidates, total scores, reason codes like `ETA_3.0MIN`, `GOOD_RATING`), `trip_request_attempt`, and `socket_message_sent`.

#### Q20: What are the main scalability bottlenecks in this code and how would you fix them?
**Answer:**
1. **Single-Node Socket.IO:** Missing `@socket.io/redis-adapter` prevents multi-instance gateway scaling. Fix: Attach Redis Adapter.
2. **MongoDB Driver Profile Fetching:** `Driver.find()` fetches full Mongoose documents during candidate filtering. Fix: Cache driver profile attributes in Redis hashes.
3. **Fixed Poll Limit:** Scheduler worker polls 50 trips per tick. Fix: Use BullMQ delayed jobs per scheduled trip.

---

## 11. SUMMARY TABLE OF UNIMPLEMENTED / MISSING FEATURES

| Feature / File | Codebase Status | Description / Reality in Code |
| :--- | :--- | :--- |
| **`src/services/dispatchService.js`** | **NOT IMPLEMENTED** | File contains 2 comment lines; no code exported. Logic lives in `dispatchWorker.js`. |
| **`src/api/controllers/driverController.js`** | **NOT IMPLEMENTED** | File exports empty object (`module.exports = {}`). No HTTP driver endpoints exist. |
| **`src/api/routes/driverRoutes.js`** | **NOT IMPLEMENTED** | File exports empty router. |
| **Socket.IO Redis Adapter** | **NOT IMPLEMENTED** | In-memory Socket.IO server (`gateway.js`); single-node deployment limit. |
| **Postman Test Suite / E2E Integration**| **NOT IMPLEMENTED** | No Postman collection files exist in repository. |
| **Live Database Integration Tests** | **NOT IMPLEMENTED** | All Jest tests mock MongoDB (`Trip`, `Driver`) and Redis (`redisStateService`). |
