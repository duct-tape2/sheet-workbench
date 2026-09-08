// Loaded only after an explicit Google connection action; never for the demo.
import { api } from "./api";
interface PickerResult {
  action: string;
  docs?: { id: string; name: string }[];
}
interface Picker {
  setVisible(show: boolean): void;
  dispose(): void;
}
interface PickerBuilder {
  addView(view: unknown): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setOrigin(origin: string): PickerBuilder;
  setCallback(callback: (value: PickerResult) => void): PickerBuilder;
  build(): Picker;
}
interface GoogleRuntime {
  gapi: {
    load(
      name: string,
      options: {
        callback: () => void;
        onerror: () => void;
        timeout: number;
        ontimeout: () => void;
      },
    ): void;
  };
  google: {
    picker: {
      PickerBuilder: new () => PickerBuilder;
      DocsView: new () => { setMimeTypes(type: string): unknown };
      Action: { PICKED: string; CANCEL: string };
    };
  };
}
let loading: Promise<void> | undefined;
function loadPicker() {
  if (!loading)
    loading = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://apis.google.com/js/api.js";
      script.async = true;
      script.onerror = () => {
        loading = undefined;
        reject(
          new Error(
            "Google Picker could not load. Check your browser or network.",
          ),
        );
      };
      script.onload = () => {
        const runtime = window as unknown as GoogleRuntime;
        runtime.gapi.load("picker", {
          callback: resolve,
          onerror: () => reject(new Error("Google Picker unavailable")),
          timeout: 20000,
          ontimeout: () => reject(new Error("Google Picker timed out")),
        });
      };
      document.head.append(script);
    });
  return loading;
}
export async function pickGoogleSheet(): Promise<{
  id: string;
  name: string;
} | null> {
  const [config] = await Promise.all([
    api<{ accessToken: string; developerKey: string; appId: string }>(
      "/google/picker-config",
    ),
    loadPicker(),
  ]);
  return new Promise((resolve) => {
    const p = (window as unknown as GoogleRuntime).google.picker;
    const picker = new p.PickerBuilder()
      .addView(
        new p.DocsView().setMimeTypes(
          "application/vnd.google-apps.spreadsheet",
        ),
      )
      .setOAuthToken(config.accessToken)
      .setDeveloperKey(config.developerKey)
      .setAppId(config.appId)
      .setOrigin(location.origin)
      .setCallback((result) => {
        if (
          result.action === p.Action.PICKED ||
          result.action === p.Action.CANCEL
        ) {
          picker.setVisible(false);
          picker.dispose();
          resolve(result.docs?.[0] ?? null);
        }
      })
      .build();
    picker.setVisible(true);
  });
}
