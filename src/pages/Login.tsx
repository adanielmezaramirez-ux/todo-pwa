import React, { useState } from "react";
import { api, setAuth } from "../api";
import { useNavigate, Link } from "react-router-dom";
import { AxiosError } from "axios";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const { data } = await api.post("/api/auth/login", { email, password });
      localStorage.setItem("token", data.token);
      setAuth(data.token);
      navigate("/dashboard");
    } catch (err) {
      if (err instanceof AxiosError) {
        setError(err?.response?.data?.message || "Error al iniciar sesión");
      } else {
        setError("Error al iniciar sesión");
      }
    }
  }

  return (
    <div className="login-container">
      <form onSubmit={onSubmit} className="login-box">
        <h2>Iniciar Sesión</h2>
        
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          required
        />
        
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Contraseña"
          required
        />
        
        <button type="submit">Entrar</button>
        
        {error && <p className="error-message">{error}</p>}
        
        <p>
          ¿No tienes cuenta?{" "}
          <Link to="/register">Regístrate aquí</Link>
        </p>
      </form>
    </div>
  );
}