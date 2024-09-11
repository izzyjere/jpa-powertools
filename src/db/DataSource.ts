import { QueryRunner } from "./QueryRunner";

export class DataSource {
  private url: string;
  private user: string;
  private password: string;
  private database: string;
  private options: any;

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

  createQueryRunner(): QueryRunner {
    return new QueryRunner(this.url, this.user, this.password, this.database, this.options);
  }
}
