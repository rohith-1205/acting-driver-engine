// Socket Gateway: initializes the Socket.IO server, manages driver connection status, and handles real-time bidirectional messaging.
const { Server } = require('socket.io');
const config = require('../config/env');
const logger = require('../utils/logger');
const handlers = require('./handlers');
const Driver = require('../models/Driver');
const driverLocationService = require('../services/driverLocationService');

let io = null;

/**
 * Initializes the Socket.IO gateway attached to an HTTP server or running standalone.
 * @param {Object} [server] - Optional HTTP/HTTPS server instance
 * @returns {Server}
 */
const initSocketGateway = (server) => {
  const port = config.socket.port || 4001;
  
  try {
    io = new Server(server || port, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST']
      }
    });

    logger.info(`Socket.IO Gateway listening on port ${port}`);

    io.on('connection', (socket) => {
      logger.info(`Channel connection hook mapped onto active descriptor: ${socket.id}`);

      // Allow drivers to register in their private room namespace (Part 3 compat)
      socket.on('join_driver_room', (data) => {
        if (data && data.driverId) {
          const roomName = `driver:room:${data.driverId}`;
          socket.join(roomName);
          logger.debug(`Socket ${socket.id} joined room: ${roomName}`);
          socket.emit('joined', { room: roomName });
        }
      });

      // Driver Online Identity Mapping Sequence
      socket.on('driver_register_presence', async (data) => {
        if (!data || !data.driverId) {
          logger.warn('Socket driver_register_presence: Invalid presence payload parameters');
          return;
        }
        const { driverId, regionCode } = data;
        // Map socket descriptor instance directly to a standard workspace tracking room alignment
        socket.join(`driver:room:${driverId}`);
        socket.join(`region:room:${regionCode || 'CMR'}`);
        socket.driverId = driverId;
        socket.regionCode = regionCode || 'CMR';
        logger.info(`Driver ${driverId} presence registered on socket ${socket.id} in region ${socket.regionCode}`);
      });

      // Telemetry Location Processing Hook Pipeline
      socket.on('driver_telemetry_ping', async (coords) => {
        if (!socket.driverId || !coords) return;
        const { longitude, latitude } = coords;
        
        logger.debug(`Driver telemetry ping received for driver ${socket.driverId}: [${longitude}, ${latitude}]`);
        
        // Wire payload stream parameters directly into Driver location storage engine services
        await driverLocationService.upsertDriverLocation(
          socket.driverId, 
          longitude, 
          latitude, 
          socket.regionCode
        );
      });

      // Attach driver reject/accept event handlers
      handlers.registerHandlers(io, socket);

      // Disconnection Safe Extraction Handler
      socket.on('disconnect', async () => {
        if (socket.driverId) {
          logger.warn(`Driver network signal dropped: ${socket.driverId}. Checking loop constraints.`);
          // Retain geographic telemetry record indices but flag availability indicators false
          await Driver.updateOne(
            { _id: socket.driverId },
            { $set: { "driverStatus.status": "offline", "driverStatus.updatedOn": Date.now() } }
          );
        } else {
          logger.debug(`Socket client disconnected: ${socket.id}`);
        }
      });
    });

    return io;
  } catch (err) {
    logger.error(`Failed to initialize Socket Gateway: ${err.message}`);
    throw err;
  }
};

/**
 * Returns the active Socket.IO server instance.
 * @returns {Server|null}
 */
const getIO = () => {
  return io;
};

module.exports = {
  initSocketGateway,
  getIO
};
