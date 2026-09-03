import { desc } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';

import { db } from '../db/client';
import { createVisit, updateVisit } from '../db/mutations';
import { visits, type Visit } from '../db/schema';
import { styles } from './styles';

export function VisitsScreen() {
  const [patientName, setPatientName] = useState('');
  const [notes, setNotes] = useState('');
  const [editing, setEditing] = useState<Visit | null>(null);

  // Re-runs whenever the underlying table changes, so the list updates after
  // an insert, an edit, or a sync without any manual refetch.
  const { data: rows } = useLiveQuery(
    db.select().from(visits).orderBy(desc(visits.createdAt)),
  );

  const canSubmit = patientName.trim().length > 0;

  async function addVisit() {
    if (!canSubmit) return;

    // Goes through the mutation log, like every other write. Nothing in this
    // file touches the `visits` table directly any more.
    await createVisit({
      patientName: patientName.trim(),
      notes: notes.trim(),
    });

    setPatientName('');
    setNotes('');
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
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

    // updateVisit diffs against the current record and logs ONLY what changed,
    // so an untouched field never enters the payload and cannot overwrite
    // another device's edit.
    await updateVisit(visit, {
      patientName: draftName.trim(),
      notes: draftNotes.trim(),
    });

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
