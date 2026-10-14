import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";

import { Panel } from "@/components/dashboard/Panel";
import { pairCodeFromHash } from "@/lib/settings/lan-access";
import { pairWithCode, useSimConnection } from "@/lib/transport/useSimConnection";

import { Field, Note, inputClass, primaryButton } from "./form";

/**
 * Shown on a LAN device the connector has not paired: the player types the one-time code
 * from Settings on the PC. Nothing else is fetched until this succeeds.
 */
export function PairDeviceGate({ fetchImpl }: { fetchImpl?: typeof fetch | undefined }) {
  const { pairingRequired, reconnect } = useSimConnection();
  if (!pairingRequired) return null;
  return <PairDeviceForm onPaired={() => reconnect?.()} fetchImpl={fetchImpl} />;
}

export function PairDeviceForm({
  onPaired,
  fetchImpl,
}: {
  onPaired: () => void;
  fetchImpl?: typeof fetch | undefined;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("Tablet");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    const fromLink = pairCodeFromHash(window.location.hash);
    if (fromLink) setCode(fromLink);
  }, []);

  const submit = async () => {
    setBusy(true);
    setNote(null);
    const r = await pairWithCode(code, name, fetchImpl);
    setBusy(false);
    if (!r.ok) {
      setNote({ tone: "error", text: r.message });
      return;
    }
    setNote({ tone: "ok", text: `Paired as ${r.deviceName}` });
    if (window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    onPaired();
  };

  return (
    <div className="mb-6 mt-4">
      <Panel eyebrow="LAN access" title="Pair this device" icon={KeyRound}>
        <form
          className="flex flex-col gap-4"
          data-testid="pair-device"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="text-sm text-muted-foreground">
            Cargo Ops is running on another PC on your network. On that PC open{" "}
            <strong className="text-foreground">Settings → LAN access</strong>, press{" "}
            <em>Generate pairing code</em> and type the code here. Until then this device gets no
            data.
          </p>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Pairing code" htmlFor="pair-code">
              <input
                id="pair-code"
                className={`${inputClass} font-mono uppercase tracking-[0.2em]`}
                value={code}
                maxLength={12}
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="ABCD-2345"
                onChange={(e) => setCode(e.target.value)}
                data-testid="pair-code"
              />
            </Field>
            <Field label="Name this device" htmlFor="pair-name">
              <input
                id="pair-name"
                className={inputClass}
                value={name}
                maxLength={40}
                autoComplete="off"
                onChange={(e) => setName(e.target.value)}
                data-testid="pair-name"
              />
            </Field>
            <button
              type="submit"
              className={primaryButton}
              disabled={busy || code.trim().length === 0}
              data-testid="pair-submit"
            >
              {busy ? "Pairing…" : "Pair"}
            </button>
          </div>
          <Note note={note} />
        </form>
      </Panel>
    </div>
  );
}
