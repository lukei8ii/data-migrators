import { SQSHandler } from "aws-lambda";
import sql from "mssql";
import { Pool, QueryConfig } from "pg";

let waterdeepDB = new sql.ConnectionPool(
  process.env.WATERDEEP_CONNECTION_STRING || ""
);
const userServiceDB = new Pool({
  connectionString: process.env.USER_SERVICE_CONNECTION_STRING,
});

type ExternalMapping = {
  Provider?: string;
  ExternalUserId?: string;
};

type UserResponse = {
  Email: string;
  Username: string;
  Nickname: string;
};

type RoleResponse = {
  ID: string;
  Name: string;
};

type SubscriptionTierResponse = {
  SubscriptionTier: string;
  UserID: string;
};

// For each user ID
//   Run the necessary SQL queries to read from Waterdeep
//   Write to the desired tables in User Service
//   Write to the `LastFullSync` column in the Waterdeep User table
export const handler: SQSHandler = async (event) => {
  try {
    if (!waterdeepDB.connected) {
      waterdeepDB = await waterdeepDB.connect();
    }

    for (const record of event.Records) {
      const id = parseInt(record.body);
      console.log("id", id);

      // Read user data from Waterdeep
      const userPromise = waterdeepDB.request()
        .query<UserResponse>`select Email, Username, Nickname from [User] u join [UserProfile] up on u.ID = up.UserID where u.ID = ${id}`;
      const externalMappingsPromise = waterdeepDB.request()
        .query<ExternalMapping>`select ExternalUserID as ExternalUserId, [Name] as Provider from [ExternalUserMap] eum join [ExternalAuthProvider] eap on eum.ExternalAuthProviderID = eap.ID where UserID = ${id}`;
      const subscriptionTierPromise = waterdeepDB
        .request()
        .input("UserID", sql.Int, id)
        .execute<SubscriptionTierResponse>("GetSubscriptionTierForUser");
      const rolesPromise = waterdeepDB
        .request()
        .input("UserID", sql.Int, id)
        .execute<RoleResponse>("RoleGetByUserId");

      const [user, externalMappings, subscriptionTier, roles] =
        await Promise.all([
          userPromise,
          externalMappingsPromise,
          subscriptionTierPromise,
          rolesPromise,
        ]);

      // Assemble the data
      const queryConfig = constructQueryConfig(
        id,
        user.recordset[0],
        externalMappings.recordsets.map((em) => em[0]),
        subscriptionTier.recordset[0].SubscriptionTier,
        roles.recordsets.map((r) => r[0].Name)
      );
      console.log("query config", queryConfig);

      // Write user data to User Service
      const res = await userServiceDB.query(queryConfig);

      // Log an error or success
      if (!res.rowCount) {
        console.log(`User ${id} did not migrate`, res);
      } else {
        await waterdeepDB.request()
          .query`update [User] set LastFullSync = GETDATE() where ID = ${id}`;
      }
    }
  } catch (err) {
    console.log("Do something with this error", err);
  }
};

// TODO: Refactor when you know what the new data structure will look like in PostgreSQL
const constructQueryConfig = (
  id: number,
  user: UserResponse,
  externalMappings: ExternalMapping[],
  subscriptionTier: string,
  roles: string[]
): QueryConfig => {
  return {
    text: "INSERT INTO Users(UserId, Email, Username, Nickname, DisplayName, SubscriptionTier, Roles, ExternalMappings) VALUES($1, $2, $3, $4, $5, $6, $7, $8)",
    values: [
      id,
      user.Email,
      user.Username,
      user.Nickname,
      user.Nickname || user.Username,
      subscriptionTier,
      roles,
      externalMappings,
    ],
  };
};

process.on("SIGTERM", async () => {
  console.info("Closing SQL connection...");
  waterdeepDB.close();
  console.info("SQL connection closed");

  process.exit(0);
});
