import { exec } from "child_process";

export class QueryRunner {
  private url: string;
  private user: string;
  private password: string;
  private database: string;
  private options: any;
  private connected: boolean = false;

  constructor(
    url: string,
    user: string,
    password: string,
    database: string,
    options: any
  ) {
    this.url = url;
    this.user = user;
    this.password = password;
    this.database = database;
    this.options = options;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const connectCommand = `java -cp ${this.options.driverPath}:${this.options.driverClassName} com.jpapowertools.ConnectToDatabase "${this.url}" "${this.user}" "${this.password}" "${this.database}"`;
      
      exec(connectCommand, (error, stdout, stderr) => {
        if (error) {
          console.error(`Connection error: ${stderr}`);
          reject(error);
        } else {
          console.log(`Connected: ${stdout}`);
          this.connected = true;
          resolve();
        }
      });
    });
  }

  // Run a query on the connected JDBC backend
  query(query: string, parameters: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        return reject("Not connected to the database.");
      }

      const paramString = parameters.map(p => `"${p}"`).join(",");
      const queryCommand = `java -cp ${this.options.driverPath}:${this.options.driverClassName} com.jpapowertools.RunQuery "${this.url}" "${this.user}" "${this.password}" "${this.database}" "${query}" ${paramString}`;
      
      exec(queryCommand, (error, stdout, stderr) => {
        if (error) {
          console.error(`Query error: ${stderr}`);
          reject(error);
        } else {
          const result = JSON.parse(stdout);  
          resolve(result);
        }
      });
    });
  }

  // Release the connection (close the JDBC connection)
  release(): void {
    if (this.connected) {
      const releaseCommand = `java -cp ${this.options.driverPath}:${this.options.driverClassName} com.jpapowertools.ReleaseConnection "${this.url}" "${this.user}" "${this.password}" "${this.database}"`;
      exec(releaseCommand, (error, stdout, stderr) => {
        if (error) {
          console.error(`Error releasing connection: ${stderr}`);
        } else {
          console.log(`Connection released: ${stdout}`);
          this.connected = false;
        }
      });
    }
  }
}
