if (new URLSearchParams(location.search).get("demo") === "1") {
  document.querySelectorAll("a[href='./login.html']").forEach(link => {
    const target = new URL("./" + (link.dataset.demoRole ?? "student") + ".html", location.href);
    target.searchParams.set("demo", "1");
    link.href = target.href;
  });
}
