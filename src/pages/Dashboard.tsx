import { useEffect, useMemo, useState, useCallback } from "react";
import { api, setAuth } from "../api";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import {
  cacheTasks,
  getAllTasksLocal,
  putTaskLocal,
  removeTaskLocal,
  getOutbox,
  removeFromOutbox,
  setMapping,
  getMapping,
} from "../offline/db";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import TaskComponent from './Task';

type Task = {
  _id: string;
  title: string;
  description?: string;
  status: "Pendiente" | "En Progreso" | "Completada";
  clienteId: string;
  createdAt?: string;
  deleted?: boolean;
};

type User = {
  name?: string;
  email?: string;
};

function normalizeTask(x: unknown): Task {
  const rawTask = x as Record<string, unknown>;
  const clientIdentifier = String(rawTask?.clienteId ?? rawTask?._id ?? rawTask?.id ?? crypto.randomUUID());
  return {
    _id: String(rawTask?._id ?? rawTask?.id),
    title: String(rawTask?.title ?? "(sin título)"),
    description: rawTask?.description as string | undefined ?? "",
    status:
      rawTask?.status === "Completada" ||
      rawTask?.status === "En Progreso" ||
      rawTask?.status === "Pendiente"
        ? rawTask.status
        : "Pendiente",
    clienteId: clientIdentifier,
    createdAt: rawTask?.createdAt as string | undefined,
    deleted: !!rawTask?.deleted,
  };
}

export default function Dashboard() {
  const [loading, setLoading] = useState(true);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [user, setUser] = useState<User | null>(null);

  //Estado de conexión en tiempo real
  const isOnline = useOnlineStatus();

  // Carga inicial
  useEffect(() => {
    const token = localStorage.getItem("token");
    if (token) setAuth(token);

    const controller = new AbortController();

    loadTasks(controller.signal);
    fetchProfile(controller.signal);

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sincronizar automáticamente cuando vuelve la conexión
  useEffect(() => {
    if (isOnline) {
      syncNow().catch(err => {
        console.error("Error en sincronización automática:", err);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  async function fetchProfile(signal?: AbortSignal) {
    try {
      const { data } = await api.get("/api/auth/profile", { signal });
      setUser(data);
    } catch (err) {
      // Solo loguear si no es un abort
      if (err instanceof Error && err.name !== 'AbortError' && err.name !== 'CanceledError') {
        console.warn("No se pudo cargar perfil:", err);
      }
    }
  }

  const loadTasks = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      let list: Task[] = [];
      if (navigator.onLine) {
        const { data } = await api.get("/api/tasks", { signal });
        const raw = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
        list = raw.map(normalizeTask);
        await cacheTasks(list);

        //Crear mappings para tareas existentes en el servidor
        for (const task of list) {
          // Si la tarea viene del servidor y no tiene clienteId, crear mapping
          if (task._id && !task.clienteId.startsWith('cliente-')) {
            await setMapping(task._id, task._id); // Mapear serverId a serverId para tareas existentes
          }
        }
      } else {
        list = await getAllTasksLocal();
      }
      setTasks(list);
    } catch (err) {
      // Solo loguear si no es un abort
      if (err instanceof Error && err.name !== 'AbortError' && err.name !== 'CanceledError') {
        console.error("Error cargando tareas:", err);
        // Intentar cargar desde caché local como fallback
        try {
          const localTasks = await getAllTasksLocal();
          setTasks(localTasks);
        } catch (localErr) {
          console.error("Error cargando tareas locales:", localErr);
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const syncNow = useCallback(async () => {
    console.log('Iniciando sincronización...');

    try {
      const { data } = await api.get("/api/tasks");
      const serverTasks = (Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [])
        .map(normalizeTask);

      const localTasks = await getAllTasksLocal();

      const ops = (await getOutbox()).sort((a, b) => a.ts - b.ts);

      console.log(`Servidor: ${serverTasks.length} tareas | Local: ${localTasks.length} tareas | Pendientes: ${ops.length} ops`);

      for (const op of ops) {
        try {
          switch (op.op) {
            case "create": {
              console.log(`Creando tarea: ${op.data.title}`);
              const { data: responseData } = await api.post("/api/tasks", {
                title: op.data.title,
                status: op.data.status,
                description: op.data.description || "",
              });

              const serverTask = normalizeTask(responseData);
              console.log(`Tarea creada en servidor:`, serverTask);

              await setMapping(op.clienteId, serverTask._id);
              await putTaskLocal(serverTask);
              await removeFromOutbox(op.id);
              console.log(`Mapping creado: ${op.clienteId} -> ${serverTask._id}`);
              break;
            }
            case "update": {
              //Buscar el serverId real usando el clienteId
              const serverId = await getMapping(op.clienteId);
              if (!serverId) {
                console.warn(`No se encontró serverId para actualizar: ${op.clienteId}`);
                await removeFromOutbox(op.id);
                continue;
              }

              console.log(`Actualizando tarea: ${serverId} (clienteId: ${op.clienteId})`);
              await api.put(`/api/tasks/${serverId}`, {
                title: op.data.title,
                status: op.data.status,
                description: op.data.description || "",
              });

              // Actualizar la tarea local con el serverId correcto
              const updatedTask = normalizeTask({ ...op.data, _id: serverId });
              await putTaskLocal(updatedTask);
              await removeFromOutbox(op.id);
              console.log(`Tarea actualizada: ${serverId}`);
              break;
            }
            case "delete": {
              //Buscar el serverId real usando el clienteId
              const serverId = await getMapping(op.clienteId);
              if (!serverId) {
                console.warn(`No se encontró serverId para eliminar: ${op.clienteId}`);
                await removeFromOutbox(op.id);
                continue;
              }

              console.log(`Eliminando tarea: ${serverId} (clienteId: ${op.clienteId})`);
              await api.delete(`/api/tasks/${serverId}`);
              await removeTaskLocal(serverId);
              await removeFromOutbox(op.id);
              console.log(`Tarea eliminada: ${serverId}`);
              break;
            }
          }
        } catch (err) {
          console.error(`Error sincronizando ${op.op}:`, err);
          // No removemos la operación si falla, se reintentará después
        }
      }
      
      const serverIds = new Set(serverTasks.map(t => t._id));
      
      // Mapear clienteId a serverId para comparación correcta
      const mappedLocalTasks = await Promise.all(
        localTasks.map(async (task: Task) => {
          const serverId = await getMapping(task.clienteId);
          return { ...task, mappedServerId: serverId };
        })
      );
      
      // Tareas que están en local pero no en servidor (nuevas offline)
      const localOnlyTasks = mappedLocalTasks.filter(
        t => !t.mappedServerId && !serverIds.has(t._id)
      );
      
      if (localOnlyTasks.length > 0) {
        console.log(`Subiendo ${localOnlyTasks.length} tareas nuevas offline...`);
        
        for (const task of localOnlyTasks) {
          try {
            console.log(`Subiendo: ${task.title}`);
            const { data: responseData } = await api.post("/api/tasks", {
              title: task.title,
              status: task.status,
              description: task.description || "",
            });
            
            //Guardar el mapping con el _id real del servidor
            const serverTask = normalizeTask(responseData);
            await setMapping(task.clienteId, serverTask._id);
            await putTaskLocal(serverTask);
            console.log(`Subida exitosa: ${task.clienteId} -> ${serverTask._id}`);
          } catch (err) {
            console.error(`Error subiendo tarea ${task.title}:`, err);
          }
        }
      }

      await loadTasks();
      console.log('Sincronización completada');

    } catch (err) {
      console.error('Error en sincronización:', err);
    }
  }, [loadTasks]);

  function logout() {
    localStorage.removeItem("token");
    setAuth(null);
    window.location.assign("/login");
  }

  const stats = useMemo(() => {
    const total = tasks.length;
    const done = tasks.filter((t) => t.status === "Completada").length;
    return { total, done, pending: total - done };
  }, [tasks]);

  return (
    <div className="wrap">
      <header className="topbar">
        <h1>
          <FontAwesomeIcon icon={["fas", "tint"]} /> To-Do PWA
        </h1>

        {user && (
          <span style={{ marginLeft: "20px" }}>
            <FontAwesomeIcon icon={["fas", "user"]} /> Hola, {user.name}
          </span>
        )}

        <div className="stats">
          <span title="Total de tareas">
            <FontAwesomeIcon icon={["fas", "tasks"]} /> Total: <b>{stats.total}</b>
          </span>
          <span title="Tareas completadas" style={{ color: "green" }}>
            <FontAwesomeIcon icon={["fas", "check"]} /> Hechas: <b>{stats.done}</b>
          </span>
          <span title="Tareas pendientes" style={{ color: "orange" }}>
            <FontAwesomeIcon icon={["fas", "list"]} /> Pendientes: <b>{stats.pending}</b>
          </span>
        </div>

        <div className={`estado-conexion ${isOnline ? "online" : "offline"}`}>
          <FontAwesomeIcon icon={isOnline ? "wifi" : "times-circle"} />{" "}
          {isOnline ? "Conectado" : "Fuera de línea"}
        </div>

        <button className="btn danger" onClick={logout} title="Salir de la sesión">
          <FontAwesomeIcon icon={["fas", "sign-out-alt"]} /> Salir
        </button>
      </header>

      <main className="tasks-section">
        {loading ? (
          <p>
            <FontAwesomeIcon icon={["fas", "spinner"]} spin /> Cargando tareas...
          </p>
        ) : (
          <TaskComponent tasks={tasks} setTasks={setTasks} />
        )}
      </main>
    </div>
  );
}