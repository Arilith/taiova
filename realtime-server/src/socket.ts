import { VehicleData } from "./types/VehicleData";
import { Server } from 'https';
import { Socket } from 'socket.io';
import { Database } from './database';
import { WebsocketVehicleData } from "./types/WebsocketVehicleData";

export class Websocket {
  
  private io : Socket;
  private db : Database;

  constructor(server : Server, db : Database) {
    this.SocketInit(server);
    this.db = db;
  }

  async SocketInit(server : Server) {
    console.log(`Initalizing websocket`)

    this.io = require("socket.io")(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
      },
    });

    this.io.on("connection", socket => {
      this.Socket(socket);
    })
  }

  Socket(socket : Socket) {
    console.log("New client connected.");

    socket.on("disconnect", () => {
      console.log("Client disconnected");
      //clearInterval(interval);
    })
  }

  SendDeletedVehicles(vehicles : Array<VehicleData>) : void {
    this.io.emit("deletedVehicles", vehicles);
  }

  CreateBufferFromVehicles(vehicles : Array<WebsocketVehicleData>) { 
    let buf = Buffer.alloc((4 + 4 + 4 + 15) * vehicles.length)
    vehicles.forEach((vehicle : WebsocketVehicleData, index : number) => {
      buf.writeFloatBE(vehicle.p[0], index * 27)
      buf.writeFloatBE(vehicle.p[1], index * 27 + 4)
      buf.writeUInt32BE(vehicle.v, index * 27 + 4 + 4)
      buf.write(`${vehicle.c}|${vehicle.n}`, index * 27 + 4 + 4 + 4)
      for(let i = 0; i < 15 - (vehicle.c.length + 1 + vehicle.n.length); i++) {
        buf.writeUInt8(0, index * 27 + 4 + 4 + 4 + vehicle.c.length + 1 + vehicle.n.length)
      }
    })

    return buf;
  }

  Emit() {
    setTimeout(() => {
      this.db.GetAllVehiclesSmall().then((vehicles) => this.io.emit("ovdata", this.CreateBufferFromVehicles(vehicles)))
        //Small delay to make sure the server catches up.
    }, 100)
  }

}