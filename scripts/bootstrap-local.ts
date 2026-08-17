/**
 * Provision LocalStack: the single table (+gsi1..3) and the objects bucket.
 * Idempotent — safe to run before every integration suite.
 */

import {
  CreateTableCommand,
  DynamoDBClient,
  ResourceInUseException,
} from '@aws-sdk/client-dynamodb';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { SESClient, VerifyEmailIdentityCommand } from '@aws-sdk/client-ses';

const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://127.0.0.1:4567';
const region = process.env.AWS_REGION ?? 'us-east-1';
const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };
const tableName = process.env.TABLE_NAME ?? 'ente-serverless';
const bucketName = process.env.BUCKET_NAME ?? 'ente-objects';

const ddb = new DynamoDBClient({ endpoint, region, credentials });
const s3 = new S3Client({ endpoint, region, credentials, forcePathStyle: true });
const ses = new SESClient({ endpoint, region, credentials });

const gsi = (name: string) => ({
  IndexName: name,
  KeySchema: [
    { AttributeName: `${name}pk`, KeyType: 'HASH' as const },
    { AttributeName: `${name}sk`, KeyType: 'RANGE' as const },
  ],
  Projection: { ProjectionType: 'ALL' as const },
});

try {
  await ddb.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsi1pk', AttributeType: 'S' },
        { AttributeName: 'gsi1sk', AttributeType: 'S' },
        { AttributeName: 'gsi2pk', AttributeType: 'S' },
        { AttributeName: 'gsi2sk', AttributeType: 'S' },
        { AttributeName: 'gsi3pk', AttributeType: 'S' },
        { AttributeName: 'gsi3sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [gsi('gsi1'), gsi('gsi2'), gsi('gsi3')],
    }),
  );
  console.log(`created table ${tableName}`);
} catch (err) {
  if (!(err instanceof ResourceInUseException)) throw err;
  console.log(`table ${tableName} exists`);
}

try {
  await s3.send(new CreateBucketCommand({ Bucket: bucketName }));
  console.log(`created bucket ${bucketName}`);
} catch (err) {
  const name = (err as { name?: string }).name ?? '';
  if (!name.includes('BucketAlreadyOwnedByYou') && !name.includes('BucketAlreadyExists')) throw err;
  console.log(`bucket ${bucketName} exists`);
}

try {
  await ses.send(new VerifyEmailIdentityCommand({ EmailAddress: 'verify@ente.local' }));
  console.log('verified SES identity verify@ente.local');
} catch {
  console.log('SES identity exists (or SES unavailable)');
}
