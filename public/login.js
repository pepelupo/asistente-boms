const loginForm = document.getElementById("loginForm");
const loginStatus = document.getElementById("loginStatus");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(loginForm);
  loginStatus.textContent = "Ingresando...";

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: form.get("username"),
        password: form.get("password"),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No pude iniciar sesion.");
    window.location.href = "/";
  } catch (error) {
    loginStatus.textContent = error.message;
  }
});
