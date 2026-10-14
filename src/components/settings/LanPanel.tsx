import { KeyRound, Wifi } from "lucide-react";
import { useEffect, useState } from "react";

import { Panel } from "@/components/dashboard/Panel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { EMPTY } from "@/lib/format";
import {
  formatCountdown,
  secondsLeft,
  useLanAccess,
  type LanView,
} from "@/lib/settings/lan-access";

import { Note, SettingRow, primaryButton, secondaryButton } from "./form";
import type { SettingsContext } from "./SettingsPanels";

function when(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : EMPTY;
}

/** LAN opt-in: status, bound URLs, saved setting, pairing code and paired devices. */
export function LanPanel({
  ctx,
  fetchImpl,
}: {
  ctx: SettingsContext;
  fetchImpl?: typeof fetch | undefined;
}) {
  const enabled = ctx.served && ctx.connected;
  const lan = useLanAccess(enabled, fetchImpl);
  const [confirmOn, setConfirmOn] = useState(false);

  return (
    <Panel
      className="col-span-12"
      eyebrow="Optional · off by default"
      title="LAN access (tablet or second PC)"
      icon={Wifi}
    >
      <div className="flex flex-col gap-5" data-testid="lan-panel">
        {!ctx.served ? (
          <p className="rounded-md bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
            LAN access needs the local connector. This page is running in demo mode.
          </p>
        ) : lan.state.status === "device" ? (
          <p className="text-sm text-muted-foreground" data-testid="lan-paired-device">
            This device is paired over your home network as{" "}
            <strong className="text-foreground">{lan.state.name}</strong>. You can fly, run jobs and
            manage the company from here. Pairing, the LAN setting, career import, backups and
            deleting data stay on the PC running Cargo Ops.
          </p>
        ) : lan.state.status === "local" ? (
          <LocalLan
            view={lan.state.view}
            busy={lan.busy}
            onGenerate={() => void lan.generateCode()}
            onCancel={() => void lan.cancelCode()}
            onToggle={(on) => (on ? setConfirmOn(true) : void lan.saveSetting(false))}
            onRevoke={(id, name) => void lan.revoke(id, name)}
            onExpired={() => void lan.reload()}
          />
        ) : lan.state.status === "error" ? (
          <p className="text-sm text-destructive">LAN status unavailable: {lan.state.message}</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {enabled ? "Loading…" : "Comes back when the connector reconnects."}
          </p>
        )}
        <Note note={lan.note} />
        <p className="text-xs text-muted-foreground">
          Off by default: the connector only listens on 127.0.0.1. With LAN access on it also
          listens on your network, but a tablet gets nothing until you pair it with a one-time code
          from this page (5 minutes, one use; repeated wrong codes lock that device out). On Windows
          the first start with LAN access shows a firewall prompt: allow{" "}
          <strong>Private networks</strong> only, never Public.
        </p>
      </div>

      <AlertDialog open={confirmOn} onOpenChange={(o) => !o && setConfirmOn(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Allow LAN access?</AlertDialogTitle>
            <AlertDialogDescription>
              After the next connector restart, Cargo Ops also listens on your home network. Devices
              still have to pair with a code from this page before they see anything, and they
              cannot import a career, write backups or delete data. Windows will ask for firewall
              access: allow Private networks only.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="lan-confirm-on"
              onClick={() => {
                setConfirmOn(false);
                void lan.saveSetting(true);
              }}
            >
              Allow on next start
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}

function LocalLan({
  view,
  busy,
  onGenerate,
  onCancel,
  onToggle,
  onRevoke,
  onExpired,
}: {
  view: LanView;
  busy: string | null;
  onGenerate: () => void;
  onCancel: () => void;
  onToggle: (on: boolean) => void;
  onRevoke: (id: string, name: string) => void;
  onExpired: () => void;
}) {
  const saved = view.setting?.enabled ?? false;
  const left = useCountdown(view.code?.expiresAt ?? null, onExpired);
  return (
    <>
      <dl className="flex flex-col divide-y divide-border">
        <SettingRow label="Status">
          <span data-testid="lan-status">
            {view.active ? `On · listening on ${view.bind}` : "Off · 127.0.0.1 only"}
          </span>
        </SettingRow>
        <SettingRow label="Open on the tablet">
          <span className="flex flex-col items-end gap-1" data-testid="lan-urls">
            {view.active && view.urls.length > 0
              ? view.urls.map((u) => <span key={u}>{u}</span>)
              : view.active
                ? "no LAN address found"
                : EMPTY}
          </span>
        </SettingRow>
        <SettingRow label="Allow LAN access (next start)">
          <span className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{saved ? "On" : "Off"}</span>
            <Switch
              checked={saved}
              disabled={busy !== null}
              onCheckedChange={onToggle}
              aria-label="Allow LAN access from the next connector start"
              data-testid="lan-enabled"
            />
          </span>
        </SettingRow>
      </dl>
      {view.restartRequired ? (
        <p
          className="rounded-md bg-secondary/60 px-3 py-2 text-xs text-foreground"
          data-testid="lan-restart"
        >
          Restart the connector to apply: stop it with Ctrl+C and start it again
          {saved ? " (or start it once with --lan)" : ""}.
        </p>
      ) : null}

      <section aria-labelledby="lan-pair-heading" className="flex flex-col gap-3">
        <h3 id="lan-pair-heading" className="font-display text-base font-semibold">
          Pair a device
        </h3>
        {view.code && left > 0 ? (
          <div className="panel-inset flex flex-col gap-2 p-4">
            <span className="label-eyebrow">Pairing code</span>
            <span
              className="font-mono text-3xl font-semibold tracking-[0.2em] text-foreground"
              data-testid="lan-code"
            >
              {view.code.display}
            </span>
            <span className="text-xs text-muted-foreground" data-testid="lan-code-expires">
              Expires in {formatCountdown(left)} · one use
            </span>
            {view.code.pairUrls.map((u) => (
              <span key={u} className="break-all font-mono text-xs" data-testid="lan-pair-url">
                {u}
              </span>
            ))}
            <span className="text-xs text-muted-foreground">
              Type the code on the tablet, or open the link above on it.
            </span>
            <div>
              <button
                type="button"
                className={secondaryButton}
                disabled={busy !== null}
                onClick={onCancel}
              >
                Cancel code
              </button>
            </div>
          </div>
        ) : (
          <div>
            <button
              type="button"
              className={primaryButton}
              disabled={!view.active || busy !== null}
              onClick={onGenerate}
              data-testid="lan-generate-code"
            >
              <KeyRound className="size-4" aria-hidden="true" />
              {busy === "code" ? "Generating…" : "Generate pairing code"}
            </button>
            {!view.active ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Turn LAN access on and restart the connector to pair a device.
              </p>
            ) : null}
          </div>
        )}
      </section>

      <section aria-labelledby="lan-devices-heading" className="flex flex-col gap-3">
        <h3 id="lan-devices-heading" className="font-display text-base font-semibold">
          Paired devices
        </h3>
        {view.devices.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="lan-no-devices">
            No paired devices.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-sm" data-testid="lan-devices">
              <caption className="sr-only">Paired LAN devices</caption>
              <thead>
                <tr className="border-b border-border">
                  {["Device", "Paired from", "Paired (UTC)", "Last seen (UTC)", ""].map((h) => (
                    <th key={h} scope="col" className="label-eyebrow px-3 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.devices.map((d) => (
                  <tr
                    key={d.id}
                    className="border-b border-border/60"
                    data-testid="lan-device-row"
                    data-id={d.id}
                  >
                    <td className="px-3 py-2 text-foreground">{d.name}</td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                      {d.pairedFrom}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                      {when(d.pairedAt)}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                      {when(d.lastSeenAt)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        className={secondaryButton}
                        disabled={busy !== null}
                        onClick={() => onRevoke(d.id, d.name)}
                        aria-label={`Revoke ${d.name}`}
                        data-testid="lan-revoke"
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/** Seconds left until `expiresAt`, ticking once a second; calls onExpired at zero. */
function useCountdown(expiresAt: string | null, onExpired: () => void): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    setNow(Date.now());
    const id = globalThis.setInterval(() => setNow(Date.now()), 1000);
    return () => globalThis.clearInterval(id);
  }, [expiresAt]);
  const left = expiresAt ? secondsLeft(expiresAt, now) : 0;
  useEffect(() => {
    if (expiresAt && left === 0) onExpired();
    // onExpired is a fresh closure each render; the trigger is reaching zero.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt, left === 0]);
  return left;
}
