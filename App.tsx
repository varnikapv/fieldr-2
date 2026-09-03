import { desc, eq } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useMigrations } from 'drizzle-orm/expo-sqlite/migrator';
import * as Crypto from 'expo-crypto';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { db } from './db/client';
import { visits, type Visit } from './db/schema';
import { syncNow, type SyncResult } from './db/sync';
import migrations from './drizzle/migrations';

export default function App() {
  // Migrations run once per device on boot. drizzle records which ones have
  // already been applied, so this is a no-op on every launch after the first.
  const { success, error } = useMigrations(db, migrations);

  if (error) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <Text style={styles.errorTitle}>Migration failed</Text>
        <Text style={styles.errorBody}>{error.message}</Text>
      </View>
    );
  }

  if (!success) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <ActivityIndicator />
        <Text style={styles.muted}>Running migrations…</Text>
      </View>
    );
  }

  return <VisitsScreen />;
}

function VisitsScreen() {
  const [patientName, setPatientName] = useState('');
  const [notes, setNotes] = useState('');
  const [editing, setEditing] = useState<Visit | null>(null);

  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Re-runs whenever the underlying table changes, so the list updates after
  // an insert, an edit, or a sync without any manual refetch.
  const { data: rows } = useLiveQuery(
    db.select().from(visits).orderBy(desc(visits.createdAt)),
  );

  const canSubmit = patientName.trim().length > 0;

  async function addVisit() {
    if (!canSubmit) return;

    // One clock reading for both columns: at creation the row has never been
    // updated, so createdAt and updatedAt are the same instant by definition.
    const now = new Date();

    await db.insert(visits).values({
      id: Crypto.randomUUID(),
      patientName: patientName.trim(),
      notes: notes.trim(),
      createdAt: now,
      updatedAt: now,
    });

    setPatientName('');
    setNotes('');
  }

  async function runSync() {
    setSyncing(true);
    setSyncError(null);
    try {
      setLastSync(await syncNow());
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <StatusBar style="auto" />

      <View style={styles.form}>
        <Text style={styles.title}>FieldNote</Text>

        <TextInput
          style={styles.input}
          placeholder="Patient name"
          value={patientName}
          onChangeText={setPatientName}
          autoCapitalize="words"
          returnKeyType="next"
        />

        <TextInput
          style={[styles.input, styles.multiline]}
          placeholder="Notes"
          value={notes}
          onChangeText={setNotes}
          multiline
        />

        <Pressable
          style={[styles.button, !canSubmit && styles.buttonDisabled]}
          onPress={addVisit}
          disabled={!canSubmit}
        >
          <Text style={styles.buttonLabel}>Add visit</Text>
        </Pressable>

        <Pressable
          style={[styles.button, styles.syncButton, syncing && styles.buttonDisabled]}
          onPress={runSync}
          disabled={syncing}
        >
          <Text style={styles.buttonLabel}>
            {syncing ? 'Syncing…' : 'Sync now'}
          </Text>
        </Pressable>

        <SyncSummary result={lastSync} error={syncError} />
      </View>

      <FlatList
        data={rows ?? []}
        keyExtractor={(visit) => visit.id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <Text style={styles.listHeader}>
            {(rows ?? []).length} visit{(rows ?? []).length === 1 ? '' : 's'}
          </Text>
        }
        ListEmptyComponent={
          <Text style={styles.muted}>No visits yet. Add one above.</Text>
        }
        renderItem={({ item }) => (
          <VisitRow visit={item} onPress={() => setEditing(item)} />
        )}
        keyboardShouldPersistTaps="handled"
      />

      <EditVisitModal visit={editing} onClose={() => setEditing(null)} />
    </KeyboardAvoidingView>
  );
}

/**
 * The whole point of the on-screen summary: when a sync silently destroys a
 * local edit, "overwritten locally" is the only visible trace of it.
 */
function SyncSummary({
  result,
  error,
}: {
  result: SyncResult | null;
  error: string | null;
}) {
  if (error) {
    return <Text style={styles.syncError}>Sync failed: {error}</Text>;
  }
  if (!result) {
    return <Text style={styles.syncSummary}>Not synced yet.</Text>;
  }
  return (
    <Text style={styles.syncSummary}>
      Last sync {result.at.toLocaleTimeString()} · pushed {result.pushed}
      {result.discardedByServer > 0
        ? ` (server discarded ${result.discardedByServer})`
        : ''}{' '}
      · pulled {result.pulled} · new {result.insertedLocally} · overwritten{' '}
      {result.overwrittenLocally}
    </Text>
  );
}

function VisitRow({ visit, onPress }: { visit: Visit; onPress: () => void }) {
  const edited = visit.updatedAt.getTime() !== visit.createdAt.getTime();

  return (
    <Pressable style={styles.row} onPress={onPress}>
      <Text style={styles.rowName}>{visit.patientName}</Text>
      {visit.notes.length > 0 && <Text style={styles.rowNotes}>{visit.notes}</Text>}
      <Text style={styles.rowMeta}>
        {visit.id.slice(0, 8)} · updated {visit.updatedAt.toLocaleTimeString()}
        {edited ? ' (edited)' : ''}
      </Text>
    </Pressable>
  );
}

/**
 * Editing exists because Phase 2's failure requires two devices changing the
 * same visit. Saving stamps a fresh `updatedAt` — the value last-write-wins
 * then uses to decide which device's whole row survives.
 */
function EditVisitModal({
  visit,
  onClose,
}: {
  visit: Visit | null;
  onClose: () => void;
}) {
  const [draftName, setDraftName] = useState('');
  const [draftNotes, setDraftNotes] = useState('');
  const [loadedId, setLoadedId] = useState<string | null>(null);

  if (visit && visit.id !== loadedId) {
    setLoadedId(visit.id);
    setDraftName(visit.patientName);
    setDraftNotes(visit.notes);
  }

  async function save() {
    if (!visit) return;

    await db
      .update(visits)
      .set({
        patientName: draftName.trim(),
        notes: draftNotes.trim(),
        updatedAt: new Date(),
      })
      .where(eq(visits.id, visit.id));

    setLoadedId(null);
    onClose();
  }

  return (
    <Modal
      visible={visit !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.modal}>
        <Text style={styles.title}>Edit visit</Text>
        <Text style={styles.muted}>{visit?.id}</Text>

        <TextInput
          style={styles.input}
          value={draftName}
          onChangeText={setDraftName}
          placeholder="Patient name"
          autoCapitalize="words"
        />
        <TextInput
          style={[styles.input, styles.multiline]}
          value={draftNotes}
          onChangeText={setDraftNotes}
          placeholder="Notes"
          multiline
        />

        <Pressable style={styles.button} onPress={save}>
          <Text style={styles.buttonLabel}>Save</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.secondaryButton]}
          onPress={() => {
            setLoadedId(null);
            onClose();
          }}
        >
          <Text style={styles.secondaryLabel}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff', paddingTop: 64 },
  centered: { alignItems: 'center', justifyContent: 'center', gap: 8 },
  form: { paddingHorizontal: 16, gap: 8 },
  modal: { flex: 1, padding: 24, gap: 12, backgroundColor: '#fff' },
  title: { fontSize: 28, fontWeight: '700', marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#d4d4d8',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  multiline: { minHeight: 72, textAlignVertical: 'top' },
  button: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  syncButton: { backgroundColor: '#0f766e' },
  secondaryButton: { backgroundColor: '#f4f4f5' },
  secondaryLabel: { color: '#3f3f46', fontSize: 16, fontWeight: '600' },
  buttonDisabled: { opacity: 0.5 },
  buttonLabel: { color: '#fff', fontSize: 16, fontWeight: '600' },
  syncSummary: { fontSize: 12, color: '#52525b' },
  syncError: { fontSize: 12, color: '#b91c1c' },
  listContent: { padding: 16, gap: 12 },
  listHeader: { fontSize: 13, fontWeight: '600', color: '#71717a' },
  row: {
    borderWidth: 1,
    borderColor: '#e4e4e7',
    borderRadius: 8,
    padding: 12,
    gap: 4,
  },
  rowName: { fontSize: 16, fontWeight: '600' },
  rowNotes: { fontSize: 14, color: '#3f3f46' },
  rowMeta: { fontSize: 12, color: '#a1a1aa', fontVariant: ['tabular-nums'] },
  muted: { color: '#71717a' },
  errorTitle: { fontSize: 18, fontWeight: '700' },
  errorBody: { color: '#b91c1c', textAlign: 'center', paddingHorizontal: 24 },
});
