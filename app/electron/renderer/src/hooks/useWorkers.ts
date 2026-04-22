import { useCallback, useEffect } from 'react';
import { workersList } from '../api/gateway';
import { useChatStore } from '../store/chatStore';

export function useWorkers() {
  const setWorkers = useChatStore((s) => s.setWorkers);

  const reload = useCallback(() => {
    workersList()
      .then(setWorkers)
      .catch((err) => console.error('Failed to load workers:', err));
  }, [setWorkers]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { reload };
}
