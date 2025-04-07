# File: agentic-tests/test_runner.py
from crewai import Crew
from agents.test_agents import test_agents
from tasks.test_tasks import test_tasks
from datetime import datetime
import json
import os

# Set up logging
timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
log_dir = "logs"
os.makedirs(log_dir, exist_ok=True)
log_path = os.path.join(log_dir, f"agentic_test_log_{timestamp}.json")

# Create crew
crew = Crew(
    agents=list(test_agents.values()),
    tasks=test_tasks,
    verbose=True
)

# Run the test crew
if __name__ == "__main__":
    print("\n🚀 Starting agentic test suite...\n")
    results = crew.kickoff()

    with open(log_path, "w", encoding="utf-8") as f:
        json.dump({"timestamp": timestamp, "result": str(results)}, f, indent=2)

    print("\n✅ Test run complete. Summary:")
    print(results)
    print(f"\n📁 Results saved to: {log_path}")
