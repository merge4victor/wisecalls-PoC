"use strict";

function findStorageConfigAssociationId(storageConfigs, streamArn) {
  const match = (storageConfigs || []).find(
    (config) => config.KinesisStreamConfig && config.KinesisStreamConfig.StreamArn === streamArn
  );
  return match ? match.AssociationId : undefined;
}

async function handler(event) {
  const { instanceId, streamArn, streamName } = event;
  const { ConnectClient, ListInstanceStorageConfigsCommand, DisassociateInstanceStorageConfigCommand } =
    await import("@aws-sdk/client-connect");
  const { KinesisClient, DeleteStreamCommand } = await import("@aws-sdk/client-kinesis");
  const connect = new ConnectClient({});
  const kinesis = new KinesisClient({});

  const listResult = await connect.send(
    new ListInstanceStorageConfigsCommand({
      InstanceId: instanceId,
      ResourceType: "REAL_TIME_CONTACT_ANALYSIS_SEGMENTS"
    })
  );
  const associationId = findStorageConfigAssociationId(listResult.StorageConfigs, streamArn);

  if (associationId) {
    await connect.send(
      new DisassociateInstanceStorageConfigCommand({
        InstanceId: instanceId,
        AssociationId: associationId,
        ResourceType: "REAL_TIME_CONTACT_ANALYSIS_SEGMENTS"
      })
    );
  }

  try {
    await kinesis.send(new DeleteStreamCommand({ StreamName: streamName, EnforceConsumerDeletion: true }));
  } catch (err) {
    if (err.name !== "ResourceNotFoundException") throw err;
  }

  return { ok: true, disassociated: Boolean(associationId) };
}

module.exports = { handler, findStorageConfigAssociationId };
