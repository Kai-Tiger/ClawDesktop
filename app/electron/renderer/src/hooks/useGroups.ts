import { useCallback, useEffect } from 'react';
import { groupsList } from '../api/gateway';
import { useChatStore } from '../store/chatStore';

export function useGroups() {
  const setGroups = useChatStore((s) => s.setGroups);

  const reload = useCallback(() => {
    groupsList()
      .then(setGroups)
      .catch((err) => console.error('Failed to load groups:', err));
  }, [setGroups]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { reload };
}
