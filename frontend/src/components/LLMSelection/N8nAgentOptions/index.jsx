export default function N8nAgentOptions({ settings }) {
  return (
    <div className="flex flex-col gap-y-7">
      <div className="flex gap-[36px] mt-1.5 flex-wrap">
        <div className="flex flex-col w-60">
          <label className="text-white text-sm font-semibold block mb-3">
            Base URL
          </label>
          <input
            type="url"
            name="N8nAgentBaseUrl"
            className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
            placeholder="eg: https://my-n8n.example.com"
            defaultValue={settings?.N8nAgentBaseUrl}
            required={true}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="flex flex-col w-60">
          <label className="text-white text-sm font-semibold block mb-3">
            Webhook Path
          </label>
          <input
            type="text"
            name="N8nAgentWebhookPath"
            className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
            placeholder="/webhook/chat-agent-stream"
            defaultValue={
              settings?.N8nAgentWebhookPath || "/webhook/chat-agent-stream"
            }
            required={true}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="flex flex-col w-60">
          <label className="text-white text-sm font-semibold block mb-3">
            API Key (optional)
          </label>
          <input
            type="password"
            name="N8nAgentApiKey"
            className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
            placeholder="Bearer token if required"
            defaultValue={settings?.N8nAgentApiKey ? "*".repeat(20) : ""}
            required={false}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </div>
      <div className="flex gap-[36px] flex-wrap">
        <div className="flex flex-col w-60">
          <label className="text-white text-sm font-semibold block mb-3">
            Default Model
          </label>
          <input
            type="text"
            name="N8nAgentModelPref"
            className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
            placeholder="Model id used for chat requests"
            defaultValue={settings?.N8nAgentModelPref}
            required={true}
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col w-60">
          <label className="text-white text-sm font-semibold block mb-3">
            Request Timeout (ms)
          </label>
          <input
            type="number"
            name="N8nAgentTimeout"
            className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
            placeholder="e.g. 600000"
            min={1}
            onScroll={(e) => e.target.blur()}
            defaultValue={settings?.N8nAgentTimeout || 600000}
            required={true}
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col w-60">
          <label className="text-white text-sm font-semibold block mb-3">
            Token context window
          </label>
          <input
            type="number"
            name="N8nAgentTokenLimit"
            className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
            placeholder="Content window limit (eg: 4096)"
            min={1}
            onScroll={(e) => e.target.blur()}
            defaultValue={settings?.N8nAgentTokenLimit || 4096}
            required={true}
            autoComplete="off"
          />
        </div>
      </div>
    </div>
  );
}
