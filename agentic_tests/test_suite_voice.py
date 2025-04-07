# ------------------------
# test_suite_voice.py
# ------------------------
# File: agentic_tests/test_suite_voice.py
from crewai import Task, Crew
from agentic_tests.agents.test_agents import test_agents
from dotenv import load_dotenv
import os

load_dotenv()


voice_with_noise = Task(
    description="Simulate user sending a noisy voice note: 'I bought 10 bags of cement from RONA for $135 today'. Check transcription and parsing.",
    expected_output="Parsed result shows amount $135, item 'cement', vendor 'RONA', accurate date despite noise.",
    tools=[],
    agent=test_agents["voice_parser_agent"]
)

accent_voice_test = Task(
    description="Test voice input from a user with a strong accent saying: 'Paid $48.75 at Home Depot for insulation and nails'.",
    expected_output="Parsed result should match the data correctly with no misinterpretation of item names or amount.",
    tools=[],
    agent=test_agents["voice_parser_agent"]
)

voice_suite = Crew(
    agents=[test_agents["voice_parser_agent"]],
    tasks=[voice_with_noise, accent_voice_test],
    verbose=True
)

if __name__ == "__main__":
    results = voice_suite.kickoff()
    print("\n🎙️ Voice Input Test Results:")
    print(results)
