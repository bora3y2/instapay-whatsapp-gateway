import mongoose from "mongoose";
import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";

/**
 * Baileys auth state stored in MongoDB instead of a local folder, so a restart
 * or redeploy does not force the merchant to scan a new QR code.
 */
const AuthSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, index: true },
    key: { type: String, required: true },
    value: { type: String, required: true },
  },
  { versionKey: false },
);

AuthSchema.index({ sessionId: 1, key: 1 }, { unique: true });

const AuthModel =
  mongoose.models.WhatsAppGatewayAuth ||
  mongoose.model("WhatsAppGatewayAuth", AuthSchema, "whatsapp_gateway_auth");

export async function useMongoAuthState(sessionId) {
  const readData = async (key) => {
    const doc = await AuthModel.findOne({ sessionId, key }).lean();
    if (!doc) return null;
    try {
      return JSON.parse(doc.value, BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const writeData = async (data, key) => {
    const value = JSON.stringify(data, BufferJSON.replacer);
    await AuthModel.updateOne({ sessionId, key }, { $set: { value } }, { upsert: true });
  };

  const removeData = async (key) => {
    await AuthModel.deleteOne({ sessionId, key });
  };

  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`key-${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category] ?? {})) {
              const value = data[category][id];
              const key = `key-${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, "creds"),
    hasCreds: async () => Boolean(await readData("creds")),
    clear: () => AuthModel.deleteMany({ sessionId }),
  };
}
