from dotenv import load_dotenv
import os
load_dotenv()
print("OPENAI_API_KEY from env:", os.getenv("OPENAI_API_KEY"))
from crewai import Task, Crew
from agentic_tests.agents.test_agents import test_agents
from crewai_tools import FileReadTool
import os


# Define tasks to test key features
text_expense_test = Task(
    description="Simulate user sending: 'just got $17.50 of nails and glue from Home Depot today'. Check if the spreadsheet logs this correctly.",
    expected_output="A new row should be created with amount $17.50, items 'nails and glue', vendor 'Home Depot', and correct date.",
    tools=[FileReadTool()],
    agent=test_agents["expense_logger_agent"]
)

image_expense_test = Task(
    description="Simulate user uploading an image of a receipt from RONA for $48.00. Check parsing and spreadsheet logging accuracy.",
    expected_output="A row is created with amount $48.00, correct date and vendor = RONA, pulled from the image using Document AI.",
    tools=[],
    agent=test_agents["expense_logger_agent"]
)

voice_expense_test = Task(
    description="Simulate a user sending a WhatsApp voice note that says: 'Spent $95 on roofing nails and tar from Roofmart yesterday'. Check transcription and spreadsheet logging.",
    expected_output="Parsed result should show $95, items: 'roofing nails and tar', vendor: 'Roofmart', date: yesterday's date.",
    tools=[],
    agent=test_agents["voice_parser_agent"]
)

onboarding_test = Task(
    description="Simulate a first-time user message. Verify if onboarding is triggered and a new spreadsheet is created.",
    expected_output="Assistant should welcome the user, ask for job name, and create a new Google Sheet for expense logging.",
    tools=[],
    agent=test_agents["onboarding_agent"]
)

quote_test = Task(
    description="Simulate a user requesting a quote for 500 sq ft of siding and 100 ft of eavestrough. Verify correct calculation and PDF quote generation.",
    expected_output="Quote should include accurate pricing pulled from Google Sheets or static data, PDF should be generated and ready to send.",
    tools=[],
    agent=test_agents["quote_generator_agent"]
)

chart_test = Task(
    description="Simulate a user asking 'show me a chart of last month's expenses by vendor'. Check if chart is generated using chartjs-node-canvas and returned properly.",
    expected_output="Chart image should display vendors on X-axis, expense totals on Y-axis, and reflect correct data from spreadsheet.",
    tools=[],
    agent=test_agents["chart_creator_agent"]
)

spreadsheet_email_test = Task(
    description="Simulate user command 'email me my spreadsheet for March'. Validate the file is attached and email is sent using SendGrid.",
    expected_output="Email is successfully sent to the user’s address with the correct spreadsheet attached as a .xlsx file.",
    tools=[],
    agent=test_agents["email_dispatch_agent"]
)

if __name__ == "__main__":
    results = test_suite.kickoff()
    print("\n✅ Test Results:")
    print(results)

# Combine tasks into a single test crew
test_suite = Crew(
    agents=list(test_agents.values()),
    tasks=[
        text_expense_test,
        image_expense_test,
        voice_expense_test,
        onboarding_test,
        quote_test,
        chart_test,
        spreadsheet_email_test
    ],
    verbose=True
)