// Login / signup logic. The same page serves both /login and /signup, we detect
// which from the URL and toggle the extra fields.
(function () {
  const isSignup = location.pathname === "/signup";
  const $ = (id) => document.getElementById(id);
  const alertBox = $("alert");

  if (isSignup) {
    $("title").textContent = "Create your account";
    $("subtitle").textContent = "Start your free trial, no credit card required";
    $("nameField").style.display = "";
    $("orgField").style.display = "";
    $("pwHint").style.display = "";
    $("submit").textContent = "Create account →";
    $("password").autocomplete = "new-password";
    $("switch").innerHTML = 'Already have an account? <a href="/login">Log in</a>';
  }

  function showError(msg) {
    alertBox.textContent = msg;
    alertBox.className = "alert alert-error show";
  }

  // Surface an error returned from the GitHub OAuth callback (?error=...).
  const errParam = new URLSearchParams(location.search).get("error");
  if (errParam) showError(errParam === "github_state" ? "GitHub sign-in expired, please try again." : "GitHub sign-in failed: " + errParam);

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    alertBox.className = "alert alert-error";
    const btn = $("submit");
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = isSignup ? "Creating…" : "Logging in…";

    const payload = {
      email: $("email").value.trim(),
      password: $("password").value,
    };
    if (isSignup) {
      payload.name = $("name").value.trim();
      payload.org = $("org").value.trim().toLowerCase().replace(/\s+/g, "-");
      if (!payload.org) { showError("Please enter an organization name."); btn.disabled = false; btn.textContent = original; return; }
      if (payload.password.length < 8) { showError("Password must be at least 8 characters."); btn.disabled = false; btn.textContent = original; return; }
    }

    try {
      const res = await fetch(isSignup ? "/api/auth/signup" : "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error || "Something went wrong."); btn.disabled = false; btn.textContent = original; return; }
      location.href = "/app";
    } catch (err) {
      showError("Network error, is the server running?");
      btn.disabled = false;
      btn.textContent = original;
    }
  });
})();
