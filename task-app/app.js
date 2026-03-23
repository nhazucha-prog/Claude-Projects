(() => {
  const input = document.getElementById("taskInput");
  const dateInput = document.getElementById("dateInput");
  const addBtn = document.getElementById("addBtn");
  const taskList = document.getElementById("taskList");
  const stats = document.getElementById("stats");
  const taskCount = document.getElementById("taskCount");
  const clearCompleted = document.getElementById("clearCompleted");
  const filterBtns = document.querySelectorAll(".filter");

  let tasks = JSON.parse(localStorage.getItem("tasks") || "[]");
  let currentFilter = "all";

  function save() {
    localStorage.setItem("tasks", JSON.stringify(tasks));
  }

  function render() {
    const filtered = tasks.filter((t) => {
      if (currentFilter === "active") return !t.done;
      if (currentFilter === "completed") return t.done;
      return true;
    });

    taskList.innerHTML = "";

    if (filtered.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent =
        currentFilter === "completed"
          ? "No completed tasks yet"
          : currentFilter === "active"
            ? "All caught up!"
            : "Add a task to get started";
      taskList.appendChild(empty);
    } else {
      filtered.forEach((task) => {
        const li = document.createElement("li");
        li.className = "task-item";

        const checkbox = document.createElement("div");
        checkbox.className = "checkbox" + (task.done ? " checked" : "");
        checkbox.addEventListener("click", () => toggleTask(task.id));

        const content = document.createElement("div");
        content.className = "task-content";

        const text = document.createElement("span");
        text.className = "task-text" + (task.done ? " done" : "");
        text.textContent = task.text;
        content.appendChild(text);

        if (task.dueDate) {
          const dateEl = document.createElement("span");
          dateEl.className = "task-date" + (!task.done ? " " + dueDateClass(task.dueDate) : "");
          dateEl.textContent = formatDate(task.dueDate);
          content.appendChild(dateEl);
        }

        const del = document.createElement("button");
        del.className = "delete-btn";
        del.textContent = "\u00d7";
        del.setAttribute("aria-label", "Delete task");
        del.addEventListener("click", () => removeTask(task.id, li));

        li.append(checkbox, content, del);
        taskList.appendChild(li);
      });
    }

    const active = tasks.filter((t) => !t.done).length;
    const completed = tasks.filter((t) => t.done).length;
    stats.hidden = tasks.length === 0;
    taskCount.textContent = `${active} item${active !== 1 ? "s" : ""} left`;
    clearCompleted.hidden = completed === 0;
  }

  function formatDate(dateStr) {
    const date = new Date(dateStr + "T00:00:00");
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function dueDateClass(dateStr) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const due = new Date(dateStr + "T00:00:00");
    const diff = (due - now) / (1000 * 60 * 60 * 24);
    if (diff < 0) return "overdue";
    if (diff <= 2) return "due-soon";
    return "";
  }

  function addTask() {
    const text = input.value.trim();
    if (!text) return;
    const dueDate = dateInput.value || null;
    tasks.unshift({ id: Date.now(), text, done: false, dueDate });
    input.value = "";
    dateInput.value = "";
    save();
    render();
  }

  function toggleTask(id) {
    const task = tasks.find((t) => t.id === id);
    if (task) task.done = !task.done;
    save();
    render();
  }

  function removeTask(id, li) {
    li.classList.add("removing");
    li.addEventListener("animationend", () => {
      tasks = tasks.filter((t) => t.id !== id);
      save();
      render();
    });
  }

  addBtn.addEventListener("click", addTask);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addTask();
  });

  clearCompleted.addEventListener("click", () => {
    tasks = tasks.filter((t) => !t.done);
    save();
    render();
  });

  filterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      filterBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = btn.dataset.filter;
      render();
    });
  });

  render();
})();
