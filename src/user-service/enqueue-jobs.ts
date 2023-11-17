import { APIGatewayProxyHandler } from "aws-lambda";
import { SQS } from "aws-sdk";
import sql from "mssql";
import { batchReduce } from "../utility/batch-reduce";
import { v4 as uuid } from "uuid";

let waterdeepDB = new sql.ConnectionPool(
  process.env.WATERDEEP_CONNECTION_STRING || ""
);

export const sqs = new SQS();

type UserResponse = {
  ID: string;
};

const sqsBatchLimit = 10;

// Accepts an optional batch size
// Gets all users that are active (not deleted) and have not been migrated, up to batch size amount
// Enqueues them in SQS in batches (1 ID per message, 10 messages per batch)
export const handler: APIGatewayProxyHandler = async (event) => {
  let statusCode = 200;
  let message;
  const batchSize = parseInt(
    event.queryStringParameters?.["batchSize"] ?? event.body ?? "100000"
  );
  console.log(`Processing ${batchSize} records...`);

  if (!process.env.QUEUE_URL) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        message: "No queue was found",
      }),
    };
  }

  try {
    if (!waterdeepDB.connected) {
      waterdeepDB = await waterdeepDB.connect();
    }

    const userIDs = await waterdeepDB.request()
      .query<UserResponse>`select top ${batchSize} ID from [User] where LastFullSync IS NOT NULL and <Status> = 1 order by ID`;

    for (const batch of batchReduce(
      userIDs.recordsets.map((u) => u[0]),
      sqsBatchLimit
    )) {
      const params: SQS.SendMessageBatchRequest = {
        QueueUrl: process.env.QUEUE_URL,
        Entries: [],
      };

      for (const message of batch) {
        params.Entries.push({
          Id: uuid(),
          MessageBody: JSON.stringify(message),
        });
      }

      await sqs.sendMessageBatch(params).promise();
    }

    message = `${userIDs.recordsets.length} UserID(s) added to the queue`;
  } catch (error) {
    console.log(error);
    message = error;
    statusCode = 500;
  }

  return {
    statusCode,
    body: JSON.stringify({
      message,
    }),
  };
};

process.on("SIGTERM", async () => {
  console.info("Closing SQL connection...");
  waterdeepDB.close();
  console.info("SQL connection closed");

  process.exit(0);
});
