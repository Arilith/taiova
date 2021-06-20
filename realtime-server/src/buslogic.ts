import { Database } from "./database";
import { VehicleData, vehicleState } from "./types/VehicleData";
import { resolve } from 'path';
import * as fs from 'fs';
import { Trip } from "./types/Trip";
import { ApiTrip } from "./types/ApiTrip";
import { exec } from 'child_process';
import { Route } from "./types/Route";
import { TripPositionData } from "./types/TripPositionData";
import * as turf from '@turf/turf'

export class BusLogic {

  private database : Database;

  constructor(database, doInit : boolean = false) {
    this.database = database;

    if(doInit) this.Initialize();
  }

  private async Initialize() {
    await this.ClearBusses();

    setInterval(async () => {
      await this.ClearBusses();
    }, parseInt(process.env.APP_CLEANUP_DELAY))
  }

  /**
   * Updates or creates a new bus depending on if it already exists or not.
   * @param busses The list of busses to update.
   */
   public async UpdateBusses(busses : Array<VehicleData>) : Promise<void> {
    await Promise.all(busses.map(async (bus) => {
      const foundTrip : Trip = await this.database.GetTrip(bus.journeyNumber, bus.planningNumber, bus.company);
      const foundRoute : Route = await this.database.GetRoute(foundTrip.routeId);

      if(foundRoute.company !== undefined) bus.company = foundRoute.company;
      if(foundRoute !== undefined) {
        bus.lineNumber = foundRoute.routeShortName;
        bus.currentRouteId = foundRoute.routeId
      }

      if(foundTrip !== undefined) bus.currentTripId = foundTrip.tripId

      let foundVehicle : VehicleData = await this.database.GetVehicle(bus.vehicleNumber, bus.company);
      
      if(Object.keys(foundVehicle).length !== 0) {
        if(process.env.APP_DO_UPDATE_LOGGING == "true") console.log(`Updating vehicle ${bus.vehicleNumber} from ${bus.company}`)
        if(!foundVehicle["_doc"]) { console.error(`Vehicle ${bus.vehicleNumber} from ${bus.company} did not include a doc. `); return }

        foundVehicle = foundVehicle["_doc"];
        
        //Merge the punctualities of the old vehicleData with the new one.
        bus.punctuality = foundVehicle.punctuality.concat(bus.punctuality);

        //Merge the updated times of the old vehicleData with the new one.
        bus.updatedTimes = foundVehicle.updatedTimes.concat(bus.updatedTimes);

        if(bus.status !== vehicleState.ONROUTE) bus.position = foundVehicle.position;

        if(bus.status === vehicleState.INIT || bus.status === vehicleState.END) {
          bus.punctuality = [];
          bus.updatedTimes = [];
        }
        //TODO: Remove punctuality data older than 60 minutes.

        bus.updatedAt = Date.now();  
        if(Object.keys(foundTrip).length !== 0) this.AddPositionToTripRoute(foundTrip.tripId, foundTrip.company, bus.position);
        await this.database.UpdateVehicle(foundVehicle, bus, true)
        
      } else {
        if(process.env.APP_DO_CREATE_LOGGING == "true") console.log(`creating new vehicle ${bus.vehicleNumber} from ${bus.company}`)
        if(bus.status === vehicleState.ONROUTE) await this.database.AddVehicle(bus, true)
      }
    }))
  }

  public async AddPositionToTripRoute (tripId : number, company : string, position : [number, number]) {
    if(position[0] == 3.3135291562643467) return;
    let retrievedTripRouteData : TripPositionData = await this.database.GetTripPositions(tripId, company);
    if(retrievedTripRouteData) { 
      retrievedTripRouteData.updatedTimes.push(new Date().getTime());
      const newUpdatedTimes = retrievedTripRouteData.updatedTimes;
      let resultArray;

      if(retrievedTripRouteData.positions.length > 1) {
        const targetPoint = turf.point(position);
        const currentLine = turf.lineString(retrievedTripRouteData.positions)
        const nearest = turf.nearestPointOnLine(currentLine, targetPoint);
        const index = nearest.properties.index;
  
        const firstHalf = retrievedTripRouteData.positions.slice(0, index);
        const secondHalf = retrievedTripRouteData.positions.slice(index)
        firstHalf.push([targetPoint.geometry.coordinates[0], targetPoint.geometry.coordinates[1]]);
        resultArray = firstHalf.concat(secondHalf);
      } else {
        retrievedTripRouteData.positions.push(position);
        resultArray = retrievedTripRouteData.positions;
      }
      
      
      retrievedTripRouteData = {
        tripId : tripId,
        company : company,
        positions: resultArray,
        updatedTimes : newUpdatedTimes
      }

    }
      
    else
      retrievedTripRouteData = {
        tripId : tripId,
        company : company,
        positions: [position],
        updatedTimes : [new Date().getTime()]
      }

    await this.database.UpdateTripPositions(tripId, company, retrievedTripRouteData);
  }

  

  /**
   * Clears busses every X amount of minutes specified in .env file.
   */
  public async ClearBusses() : Promise<void> {
    if(process.env.APP_DO_CLEANUP_LOGGING == "true") console.log("Clearing busses")
    const currentTime = Date.now();
    const fifteenMinutesAgo = currentTime - (60 * parseInt(process.env.APP_CLEANUP_VEHICLE_AGE_REQUIREMENT) * 1000);
    const RemovedVehicles = await this.database.RemoveVehiclesWhere({ updatedAt: { $lt: fifteenMinutesAgo } }, process.env.APP_DO_CLEANUP_LOGGING == "true");
  }

  /**
   * Initializes the "Koppelvlak 7 and 8 turbo" files to database.
   */
  public InitKV78() : void {
    this.InitTripsNew();
  }

  /**
   * Initializes the trips from the specified URL in the .env , or "../GTFS/extracted/trips.json" to the database.
   */
  private InitTripsNew() : void { 
    const tripsPath = resolve("GTFS\\extracted\\trips.txt.json");
    const outputPath = resolve("GTFS\\converted\\trips.json");
    fs.readFile(tripsPath, 'utf8', async(error, data) => { 
      if(error) console.error(error);
      if(data && process.env.APP_DO_CONVERTION_LOGGING == "true") console.log("Loaded trips file into memory.");
      data = data.trim();
      const lines = data.split("\n");
      const writeStream = fs.createWriteStream(outputPath)
      const convertedTrips = [];

      for(let line of lines) {
        const tripJSON : ApiTrip = JSON.parse(line);
        const realTimeTripId = tripJSON.realtime_trip_id.split(":");
        const company = realTimeTripId[0];
        const planningNumber = realTimeTripId[1];
        const tripNumber = realTimeTripId[2];

        const trip : Trip = {
          company: company,
          routeId: parseInt(tripJSON.route_id),
          serviceId: parseInt(tripJSON.service_id),
          tripId: parseInt(tripJSON.trip_id),
          tripNumber: parseInt(tripNumber),
          tripPlanningNumber: planningNumber,
          tripHeadsign: tripJSON.trip_headsign,
          tripName: tripJSON.trip_long_name,
          directionId: parseInt(tripJSON.direction_id),
          shapeId: parseInt(tripJSON.shape_id),
          wheelchairAccessible: parseInt(tripJSON.wheelchair_accessible)
        }
        writeStream.write(JSON.stringify(trip) + "\n");
      }
      
      writeStream.end(() => {
        if(process.env.APP_DO_CONVERTION_LOGGING == "true") console.log("Finished writing trips file, importing to database.");
        this.ImportTrips();
      })
    });
   
    
  }

  async ImportTrips() : Promise<void> {
    await this.database.DropTripsCollection();

    if(process.env.APP_DO_CONVERTION_LOGGING == "true") console.log("Importing trips to mongodb");

    await exec("mongoimport --db taiova --collection trips --file .\\GTFS\\converted\\trips.json", (error, stdout, stderr) => {
      if (error) {
        console.log(`error: ${error.message}`);
        return;
      }

      if (stderr) {
        console.log(`stderr: ${stderr}`);
        return;
      }

      if(process.env.APP_DO_CONVERTION_LOGGING == "true") console.log(`stdout: ${stdout}`);
    });

  }

}