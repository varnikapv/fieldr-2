import { desc, eq } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';

import { db } from '../db/client';
import { getDeviceId, shortDevice } from '../db/device';
import { mutations, type Mutation } from '../db/schema';
import { syncNow, type SyncResult } from '../db/sync';
import { styles } from './styles';

/**
 * Where a rejection becomes visible.
 *
 * A rejected operation stays in the log as a record of what this device
 * attempted, flagged here — but it is skipped during replay, so the item
 * itself has already reverted to what the server holds. There is no
 * resolution UI yet: phase 4 makes the conflict visible and honest, it does
 * not resolve it for you.
 */
export function SyncInspectorScreen() {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [last, setLast] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: pending } = useLiveQuery(
    db.select().from(mutations).where(eq(mutations.synced, false)),
  );
  const { data: flagged } = useLiveQuery(
    db
      .select()
      .from(mutations)
      .where(eq(mutations.rejected, true))
      .orderBy(desc(mutations.seq)),
  );

  useEffect(() => {
    getDeviceId().then(setDeviceId);
  }, []);

  async function run() {
    setSyncing(true);
    setError(null);
    try {
      setLast(await syncNow());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.listContent}
      data={flagged ?? []}
      keyExtractor={(row) => row.opId}
      ListHeaderComponent={
        <View style={{ gap: 8 }}>
          <Text style={styles.title}>Sync inspector</Text>
          <Text style={styles.syncSummary}>
            This device: {shortDevice(deviceId)}
          </Text>

          <Pressable
            style={[styles.button, styles.syncButton, syncing && styles.buttonDisabled]}
            onPress={run}
            disabled={syncing}
          >
            <Text style={styles.buttonLabel}>{syncing ? 'Syncing…' : 'Sync now'}</Text>
          </Pressable>

          {error ? <Text style={styles.syncError}>Sync failed: {error}</Text> : null}

          <Stat label="Queued (not yet pushed)" value={(pending ?? []).length} />
          {last ? (
            <>
              <Stat label="Last sync" value={last.at.toLocaleTimeString()} />
              <Stat label="Pushed" value={last.pushed} />
              <Stat label="Accepted" value={last.accepted} />
              <Stat label="Rejected" value={last.rejected} />
              <Stat label="Already on server" value={last.alreadyOnServer} />
              <Stat label="Pulled" value={last.pulled} />
              <Stat label="Applied locally" value={last.appliedLocally} />
            </>
          ) : (
            <Text style={styles.syncSummary}>Not synced yet.</Text>
          )}

          <Text style={styles.sectionTitle}>
            NEEDS REVIEW ({(flagged ?? []).length})
          </Text>
          {(flagged ?? []).length === 0 ? (
            <Text style={styles.muted}>No rejected operations.</Text>
          ) : null}
        </View>
      }
      renderItem={({ item }) => <FlaggedRow row={item} />}
    />
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

function FlaggedRow({ row }: { row: Mutation }) {
  const other = row.rejectionByDevice ? shortDevice(row.rejectionByDevice) : null;

  const explanation =
    row.rejectionReason === 'stale'
      ? other
        ? `Device ${other} changed this first. Your change was not applied.`
        : 'Someone else changed this first. Your change was not applied.'
      : 'That change was not a valid transition.';

  const attempted =
    row.patch.status !== undefined
      ? `tried ${row.patch.status.from} → ${row.patch.status.to}`
      : 'tried to edit fields';

  return (
    <View style={styles.flagged}>
      <Text style={styles.flaggedTitle}>Rejected: {row.rejectionReason}</Text>
      <Text style={styles.flaggedBody}>{explanation}</Text>
      <Text style={styles.rowMeta}>
        {row.entity} {row.entityId.slice(0, 8)} · {attempted} ·{' '}
        {row.timestamp.toLocaleTimeString()}
      </Text>
    </View>
  );
}
